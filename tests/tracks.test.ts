import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "./test-helpers.js";
import { fetch } from "undici";

vi.mock("undici", () => ({ fetch: vi.fn() }));

beforeEach(() => {
  process.env["CAPSULE_API_TOKEN"] = "test-token";
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["CAPSULE_API_TOKEN"];
});

describe("listEntityTracks", () => {
  it("GETs /<entity>/{id}/tracks", async () => {
    mockFetch(200, { tracks: [{ id: 1 }] });
    const { listEntityTracks } = await import("../src/tools/tracks.js");
    await listEntityTracks({ entity: "projects", entityId: 99 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/kases/99/tracks");
  });
});

describe("getTrack", () => {
  it("GETs /tracks/{id}", async () => {
    mockFetch(200, { track: { id: 5 } });
    const { getTrack } = await import("../src/tools/tracks.js");
    await getTrack({ id: 5 });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/tracks/5");
  });
});

describe("applyTrack", () => {
  it("POSTs to /tracks with body wrapped as {track: {definition, kase}} (kases→kase)", async () => {
    mockFetch(200, { track: { id: 1 } });
    const { applyTrack } = await import("../src/tools/tracks.js");
    await applyTrack({
      entity: "projects",
      entityId: 99,
      trackDefinitionId: 147602,
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toMatch(/\/tracks($|\?)/);
    const i = init as { method: string; body: string };
    expect(i.method).toBe("POST");
    // Capsule expects `definition`, not `trackDefinition` —
    // sending the latter returns 422 even though some docs suggest
    // otherwise. Verified live during the v1.0.0 sweep.
    expect(JSON.parse(i.body)).toEqual({
      track: {
        definition: { id: 147602 },
        kase: { id: 99 },
      },
    });
  });

  it("uses 'opportunity' key for opportunities", async () => {
    mockFetch(200, { track: { id: 1 } });
    const { applyTrack } = await import("../src/tools/tracks.js");
    await applyTrack({
      entity: "opportunities",
      entityId: 42,
      trackDefinitionId: 147602,
    });
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.track.opportunity).toEqual({ id: 42 });
    expect(body.track.kase).toBeUndefined();
    // definition (not trackDefinition) is what Capsule accepts.
    expect(body.track.definition).toEqual({ id: 147602 });
    expect(body.track.trackDefinition).toBeUndefined();
  });

  it("maps user-facing startDate → Capsule's trackDateOn body field", async () => {
    // Capsule's API field is `trackDateOn`, not `startDate`. Sending
    // `startDate` directly gets silently dropped (tasks then land at
    // today + daysAfter instead of <startDate> + daysAfter). The
    // user-facing parameter name stays `startDate` (more intuitive);
    // the handler renames to `trackDateOn` on the way out.
    mockFetch(200, { track: { id: 1 } });
    const { applyTrack } = await import("../src/tools/tracks.js");
    await applyTrack({
      entity: "opportunities",
      entityId: 1,
      trackDefinitionId: 1,
      startDate: "2026-06-01",
    });
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.track.trackDateOn).toBe("2026-06-01");
    // User-facing field name doesn't leak into the API body.
    expect(body.track.startDate).toBeUndefined();
  });
});

describe("updateTrack", () => {
  it("PUTs to /tracks/{id} with fields wrapped in {track: ...}", async () => {
    mockFetch(200, { track: { id: 5 } });
    const { updateTrack } = await import("../src/tools/tracks.js");
    await updateTrack({ id: 5, fields: { complete: true } });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/tracks/5");
    const i = init as { method: string; body: string };
    expect(i.method).toBe("PUT");
    expect(JSON.parse(i.body)).toEqual({ track: { complete: true } });
  });

  it("rejects empty field updates", async () => {
    const { updateTrack } = await import("../src/tools/tracks.js");
    await expect(updateTrack({ id: 1, fields: {} })).rejects.toThrow(/at least one field/);
  });
});

describe("removeTrack", () => {
  it("DELETEs /tracks/{id} when confirm=true", async () => {
    mockFetch(204, {});
    const { removeTrack } = await import("../src/tools/tracks.js");
    const result = await removeTrack({ id: 5, confirm: true });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/tracks/5");
    expect((init as { method: string }).method).toBe("DELETE");
    expect(result.removed).toBe(true);
  });
});
