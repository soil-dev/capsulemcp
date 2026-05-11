import { z } from "zod";
import {
  capsuleGetBinary,
  capsulePost,
  capsulePostBinary,
} from "../capsule/client.js";

// Attachments — the only tool surface in capsulemcp that handles binary
// content rather than JSON.
//
// Two operations:
//   get_attachment(id, maxSizeBytes?)
//     GET /attachments/{id} — returns the file's bytes plus its
//     Content-Type. The server.ts handler decides the MCP content
//     shape:
//       image/* → MCP `image` content (base64 + mimeType)
//       text/*, application/json → text content with the body decoded
//                                  as UTF-8
//       everything else → text content carrying metadata + a base64
//                         payload for downstream tools to decode
//
//   upload_attachment(filename, contentType, dataBase64, content?,
//                     partyId? | opportunityId? | projectId?)
//     POST /attachments/upload (raw bytes) → token
//     POST /entries with {attachments: [{token}]} → new note carrying
//     the attachment, linked to the chosen entity
//
//     The two HTTP calls are orchestrated together: from Claude's
//     perspective there's one tool that "uploads a file and attaches
//     it as a note on $entity". Adding an attachment to an EXISTING
//     entry is not yet supported — call this to create a new note
//     instead, or open Capsule's web UI for ad-hoc edits.

// ── Get / download ──────────────────────────────────────────────────────────

// Default cap on bytes returned to Claude. Large attachments would
// burn massive context for limited gain (Claude can't natively read
// most binary formats). User can override up to Capsule's per-file
// ceiling of 25 MB.
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const HARD_MAX_SIZE_BYTES = 25 * 1024 * 1024;
const HARD_MAX_BASE64_CHARS = Math.ceil(HARD_MAX_SIZE_BYTES / 3) * 4;

export const getAttachmentSchema = z.object({
  id: z.number().int().positive().describe("Attachment ID."),
  maxSizeBytes: z
    .number()
    .int()
    .positive()
    .max(HARD_MAX_SIZE_BYTES)
    .optional()
    .describe(
      `Refuse to return content over this size (default ${DEFAULT_MAX_SIZE_BYTES} bytes ≈ 5MB; max ${HARD_MAX_SIZE_BYTES} bytes ≈ 25MB). Files exceeding the cap return metadata only with a 'truncated: true' flag.`,
    ),
});

export interface AttachmentResult {
  contentType: string;
  buffer: Buffer;
  truncated?: boolean;
  sizeBytes: number;
}

export async function getAttachment(
  input: z.infer<typeof getAttachmentSchema>,
): Promise<AttachmentResult> {
  const cap = input.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  // Push the cap into the HTTP layer so we never buffer more than `cap`
  // bytes into memory — a malicious or buggy upstream sending a 5 GB
  // response would be aborted mid-stream rather than fully buffered
  // first and rejected after.
  const { contentType, buffer, truncated, sizeBytes } = await capsuleGetBinary(
    `/attachments/${input.id}`,
    cap,
  );
  if (truncated) {
    return { contentType, buffer: Buffer.alloc(0), truncated: true, sizeBytes };
  }
  return { contentType, buffer, sizeBytes };
}

// ── Upload + attach as new note ─────────────────────────────────────────────

// MCP SDK needs a plain ZodObject shape; enforce the exactly-one
// constraint in the handler (same pattern as add_note).
export const uploadAttachmentSchema = z.object({
  filename: z
    .string()
    .min(1)
    .describe(
      "Filename Capsule should record (e.g. 'contract.pdf'). Capsule does NOT validate consistency between filename, contentType, and the actual bytes — a typo in either is accepted and the file is stored as labelled.",
    ),
  contentType: z
    .string()
    .min(1)
    .describe(
      "MIME type of the file (e.g. 'application/pdf', 'image/png', 'text/plain'). Trusted by Capsule verbatim; not cross-checked against `filename` or the actual bytes.",
    ),
  dataBase64: z
    .string()
    .min(1)
    .max(HARD_MAX_BASE64_CHARS)
    .describe(
      "File contents, base64-encoded. Decoded server-side and uploaded as the request body. Maximum 25 MB per attachment (Capsule's documented limit); the connector rejects oversized base64 before uploading. The inbound HTTP body limit is ~35 MB which leaves room for the base64 expansion of a 25 MB binary.",
    ),
  content: z
    .string()
    .optional()
    .describe(
      "Body text for the note that will hold the attachment. Defaults to '[attachment]' if omitted.",
    ),
  partyId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Link the new note to a party (mutually exclusive with opportunityId / projectId).",
    ),
  opportunityId: z.number().int().positive().optional(),
  projectId: z.number().int().positive().optional(),
});

// Capsule's API decodes whatever bytes we send. If the caller passes
// invalid base64, `Buffer.from(x, "base64")` silently produces garbage
// (Node's tolerant base64 parser drops invalid characters), Capsule
// happily stores those bytes, and the user later finds the file is
// corrupted. Validate up-front so the error surfaces before upload.
function isValidBase64(s: string): boolean {
  // Strip optional padding then check the alphabet. Length must be a
  // multiple of 4 once padding is restored.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return false;
  const len = s.length;
  if (len % 4 !== 0) return false;
  return true;
}

function decodedBase64Size(s: string): number {
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - padding;
}

export async function uploadAttachment(
  input: z.infer<typeof uploadAttachmentSchema>,
) {
  const linked = [input.partyId, input.opportunityId, input.projectId].filter(
    Boolean,
  );
  if (linked.length !== 1) {
    throw new Error(
      "upload_attachment: provide exactly one of partyId, opportunityId, or projectId",
    );
  }
  if (!isValidBase64(input.dataBase64)) {
    throw new Error(
      "upload_attachment: dataBase64 is not valid base64 — Node's tolerant decoder would silently produce corrupt bytes. Verify the encoding (RFC 4648, padded with '=' to a multiple of 4 chars).",
    );
  }
  const decodedBytes = decodedBase64Size(input.dataBase64);
  if (decodedBytes > HARD_MAX_SIZE_BYTES) {
    throw new Error(
      `upload_attachment: decoded file is ${decodedBytes} bytes, exceeding the ${HARD_MAX_SIZE_BYTES} byte attachment limit. Split or shrink the file before uploading.`,
    );
  }

  // Step 1: upload bytes, receive token.
  const buffer = Buffer.from(input.dataBase64, "base64");
  const uploaded = await capsulePostBinary<{ upload: { token: string } }>(
    "/attachments/upload",
    buffer,
    input.contentType,
    input.filename,
  );
  const token = uploaded.upload.token;

  // Step 2: create a note that references the upload token. Capsule
  // returns the entry with the attachment metadata populated (id,
  // filename, contentType, size, etc.) once it's been wired in.
  const entryBody: Record<string, unknown> = {
    type: "note",
    content: input.content ?? "[attachment]",
    attachments: [{ token }],
  };
  if (input.partyId) entryBody["party"] = { id: input.partyId };
  if (input.opportunityId) entryBody["opportunity"] = { id: input.opportunityId };
  if (input.projectId) entryBody["kase"] = { id: input.projectId };

  return capsulePost<{ entry: unknown }>("/entries", { entry: entryBody });
}
