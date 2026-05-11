import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch } from "undici";

function mockBinary(
  status: number,
  buffer: Buffer,
  contentType = "application/octet-stream",
) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    // Real Capsule responses carry Content-Length; the client uses it
    // for its pre-buffer size cap. The mock matches that shape.
    headers: new Headers({
      "Content-Type": contentType,
      "Content-Length": String(buffer.byteLength),
    }),
    arrayBuffer: async () =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
    text: async () => buffer.toString("utf8"),
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

function mockJson(status: number, body: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    statusText: String(status),
  } as Awaited<ReturnType<typeof fetch>>);
}

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
  delete process.env["CAPSULE_MCP_READONLY"];
});

describe("getAttachment", () => {
  it("GETs /attachments/{id} and surfaces contentType + buffer", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    mockBinary(200, png, "image/png; charset=UTF-8");

    const { getAttachment } = await import("../src/tools/attachments.js");
    const result = await getAttachment({ id: 99 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/attachments/99");
    expect(result.contentType).toContain("image/png");
    expect(result.buffer.equals(png)).toBe(true);
    expect(result.sizeBytes).toBe(4);
    expect(result.truncated).toBeUndefined();
  });

  it("truncates files exceeding maxSizeBytes", async () => {
    const big = Buffer.alloc(100);
    mockBinary(200, big, "application/pdf");

    const { getAttachment } = await import("../src/tools/attachments.js");
    const result = await getAttachment({ id: 1, maxSizeBytes: 50 });

    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(100);
    expect(result.buffer.length).toBe(0);
  });

  it("respects the default 5MB cap when no maxSizeBytes provided", async () => {
    const huge = Buffer.alloc(6 * 1024 * 1024); // 6MB
    mockBinary(200, huge, "application/pdf");

    const { getAttachment } = await import("../src/tools/attachments.js");
    const result = await getAttachment({ id: 1 });

    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(6 * 1024 * 1024);
  });
});

describe("uploadAttachment", () => {
  it("uploads raw bytes with required headers, then creates a note linking the token", async () => {
    // First call: upload — returns token.
    mockJson(200, {
      upload: {
        token:
          "u1/e0/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/abc123/xyz789",
      },
    });
    // Second call: entry creation — returns the new entry with attachment metadata.
    mockJson(200, {
      entry: {
        id: 999,
        type: "note",
        attachments: [
          { id: 42, filename: "report.pdf", contentType: "application/pdf", size: 16 },
        ],
      },
    });

    const { uploadAttachment } = await import("../src/tools/attachments.js");
    const data = Buffer.from("hello-pdf-bytes!").toString("base64");
    const result = await uploadAttachment({
      filename: "report.pdf",
      contentType: "application/pdf",
      dataBase64: data,
      partyId: 254022688,
    });

    // Two calls: POST /attachments/upload, POST /entries.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);

    const [uploadUrl, uploadInit] = calls[0]!;
    expect(uploadUrl).toContain("/attachments/upload");
    const uInit = uploadInit as { method: string; headers: Record<string, string>; body: Buffer };
    expect(uInit.method).toBe("POST");
    expect(uInit.headers["Content-Type"]).toBe("application/pdf");
    expect(uInit.headers["X-Attachment-Filename"]).toBe(
      encodeURIComponent("report.pdf"),
    );
    expect(uInit.headers["Content-Length"]).toBe("16"); // "hello-pdf-bytes!" = 16 bytes
    expect(Buffer.isBuffer(uInit.body)).toBe(true);
    expect(uInit.body.toString("utf8")).toBe("hello-pdf-bytes!");

    const [entryUrl, entryInit] = calls[1]!;
    expect(entryUrl).toContain("/entries");
    const eInit = entryInit as { method: string; body: string };
    expect(eInit.method).toBe("POST");
    const sent = JSON.parse(eInit.body);
    expect(sent.entry.type).toBe("note");
    expect(sent.entry.party).toEqual({ id: 254022688 });
    expect(sent.entry.attachments).toEqual([
      {
        token:
          "u1/e0/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/abc123/xyz789",
      },
    ]);

    expect(
      (result as { entry: { attachments: unknown[] } }).entry.attachments,
    ).toHaveLength(1);
  });

  it("rejects calls with multiple anchor IDs", async () => {
    const { uploadAttachment } = await import("../src/tools/attachments.js");
    await expect(
      uploadAttachment({
        filename: "x",
        contentType: "text/plain",
        dataBase64: "aGk=",
        partyId: 1,
        opportunityId: 2,
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects calls with no anchor ID", async () => {
    const { uploadAttachment } = await import("../src/tools/attachments.js");
    await expect(
      uploadAttachment({
        filename: "x",
        contentType: "text/plain",
        dataBase64: "aGk=",
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it("defaults note content to '[attachment]' when omitted", async () => {
    mockJson(200, { upload: { token: "t" } });
    mockJson(200, { entry: { id: 1 } });

    const { uploadAttachment } = await import("../src/tools/attachments.js");
    await uploadAttachment({
      filename: "x.txt",
      contentType: "text/plain",
      dataBase64: "aGk=",
      projectId: 5,
    });

    const calls = vi.mocked(fetch).mock.calls;
    const sent = JSON.parse((calls[1]![1] as { body: string }).body);
    expect(sent.entry.content).toBe("[attachment]");
    expect(sent.entry.kase).toEqual({ id: 5 }); // projects use /kases naming
  });

  it("is blocked in read-only mode (PostBinary refuses)", async () => {
    process.env["CAPSULE_MCP_READONLY"] = "1";
    const { uploadAttachment } = await import("../src/tools/attachments.js");
    await expect(
      uploadAttachment({
        filename: "x",
        contentType: "text/plain",
        dataBase64: "aGk=",
        partyId: 1,
      }),
    ).rejects.toThrow(/read-only mode/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects invalid base64 input before making any HTTP call", async () => {
    const { uploadAttachment } = await import("../src/tools/attachments.js");
    // Contains characters outside the base64 alphabet.
    await expect(
      uploadAttachment({
        filename: "x.txt",
        contentType: "text/plain",
        dataBase64: "this is not base64!",
        partyId: 1,
      }),
    ).rejects.toThrow(/not valid base64/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects base64 with wrong padding length", async () => {
    const { uploadAttachment } = await import("../src/tools/attachments.js");
    // Length 5 is not a multiple of 4.
    await expect(
      uploadAttachment({
        filename: "x.txt",
        contentType: "text/plain",
        dataBase64: "aGVsb",
        partyId: 1,
      }),
    ).rejects.toThrow(/not valid base64/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects decoded files over Capsule's 25 MB attachment ceiling before upload", async () => {
    const { uploadAttachment } = await import("../src/tools/attachments.js");
    const tooLarge = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");

    await expect(
      uploadAttachment({
        filename: "too-large.bin",
        contentType: "application/octet-stream",
        dataBase64: tooLarge,
        partyId: 1,
      }),
    ).rejects.toThrow(/exceeding the .* attachment limit/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("accepts valid base64 (with padding)", async () => {
    mockJson(200, { upload: { token: "t" } });
    mockJson(200, { entry: { id: 1 } });

    const { uploadAttachment } = await import("../src/tools/attachments.js");
    await expect(
      uploadAttachment({
        filename: "x.txt",
        contentType: "text/plain",
        dataBase64: "aGVsbG8=", // "hello"
        partyId: 1,
      }),
    ).resolves.toBeDefined();
  });
});
