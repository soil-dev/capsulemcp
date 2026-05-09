# TODO

Deferred work — features deliberately skipped at the time they came up,
captured here so they're not forgotten and so anyone picking them up
has the context they need to start.

---

## Attachments (read + write)

Capsule entries can carry attachments (PDFs, images, etc.). The API
exposes upload and download:

- `POST /api/v2/attachments/upload` — multipart upload, returns the
  attachment metadata. Caller then references the attachment id when
  creating or updating an entry.
- `GET /api/v2/attachments/{id}` — returns the raw binary, with
  `Content-Type` matching the file (e.g. `image/png; charset=UTF-8`,
  `application/pdf`).

Both work in Capsule's API. Verified against a real attachment
(image/png, ~10kB) during the v0.5.0 endpoint audit.

### Why deferred

The attachment endpoints don't fit cleanly into the rest of
capsulemcp's interface for two reasons:

1. **Inbound binaries (download)**. Every other tool returns JSON-as-
   text via the MCP `text` content type. Attachments need either:
   - MCP `image` content (with `mimeType` + base64 `data`) for image
     types, which Claude can describe natively. Cleanest UX.
   - Base64 inside a JSON wrapper for non-image binaries (PDF, etc.)
     so Claude can pass them onwards or describe metadata. Less
     elegant; Claude can't read PDF bytes directly without a separate
     tool.
   - Routing logic in the tool that branches on Content-Type.

2. **Outbound binaries (upload)**. Capsule's upload endpoint takes
   `multipart/form-data`. MCP tools take JSON-shaped input from
   Claude. To upload, we need either:
   - A `data: base64` parameter on the tool, decoded and posted as
     multipart on the server side. Workable but verbose for Claude.
   - A two-step "give me a file path / URL, server fetches and
     uploads" model — but that puts file-system access in the MCP
     server, which we've avoided so far.

Neither blocker is hard, but both deserve their own design pass
rather than being squeezed into a multi-feature release.

### Sketch of an implementation

- New file `src/tools/attachments.ts`.
- New helper in `src/capsule/client.ts`:
  - `capsuleGetBinary(path)` → `{ contentType, buffer }` returning
    the raw bytes plus header. Mirrors the existing `capsuleGet` shape
    but skips JSON parsing.
  - `capsulePostMultipart(path, fields)` → does a multipart POST,
    returns parsed JSON. New surface; touches undici's `FormData`.
- Two tools:
  - `get_attachment(id)`:
    - For `Content-Type: image/*` → return MCP `image` content
      (`{ type: "image", data, mimeType }`).
    - For everything else → return JSON-as-text:
      `{ id, contentType, sizeBytes, data: <base64> }`.
  - `upload_attachment(filename, contentType, base64Data, ...optional
    entry-link fields)`:
    - Decodes base64, posts multipart, returns the new attachment's
      metadata.
    - Could also be split into "upload only" and "attach to entry" if
      we want orthogonal building blocks.
- Tests: at least one mock per content-type branch, one upload happy
  path, schema validation for size/base64 inputs.

### Open questions before implementing

- Should `upload_attachment` accept a URL (server fetches) instead of
  base64 from Claude? URL is simpler for Claude to produce but adds
  egress and security considerations.
- What's the right size cap for inbound attachments returned to
  Claude? Capsule itself accepts ≤25MB per file; round-tripping that
  through Claude's context window is wasteful for large PDFs.
  Consider a `maxSizeBytes` parameter that returns metadata only when
  exceeded.
- Should the tool be available in read-only mode? `get_attachment` —
  yes (it's a read). `upload_attachment` — no (gated by `!readOnly`
  like other writes).

### Endpoints involved

- `POST /api/v2/attachments/upload` (write)
- `GET /api/v2/attachments/{attachmentId}` (read)

Capsule's "Show attachment" doc:
<https://developer.capsulecrm.com/v2/operations/Entry>

---

(Add new entries above this line.)
