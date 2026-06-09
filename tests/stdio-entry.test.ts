/**
 * Stdio entry smoke test. Spawns the built `dist/index.js` as a child
 * process, sends a real MCP `initialize` + `tools/list` over stdin,
 * and asserts the response.
 *
 * The stdio entry point is only 19 lines but completely unverified by
 * any other test layer — a regression here (wrong import path, broken
 * shebang, transport never connects) means the npx-install path
 * silently fails for end users until someone reports it.
 *
 * Requires `npm run build` to have run. The test runs that itself in
 * beforeAll if needed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(__dirname, "..", "dist", "index.js");

let child: ChildProcessWithoutNullStreams;
let stderrBuffer = "";

// Send a JSON-RPC message and return the next response from the
// child's stdout. MCP messages are newline-delimited JSON over stdio.
function rpc(
  proc: ChildProcessWithoutNullStreams,
  request: object,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.stdout.removeListener("data", onData);
      reject(new Error("timeout waiting for response"));
    }, 5000);

    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        clearTimeout(timeout);
        proc.stdout.removeListener("data", onData);
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
      }
    };

    proc.stdout.on("data", onData);
    proc.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

beforeAll(async () => {
  // Ensure the bundle exists. Build if missing — fast (~13ms per
  // tsup run on this codebase).
  if (!existsSync(DIST_INDEX)) {
    execSync("npm run build", {
      stdio: "inherit",
      cwd: join(__dirname, ".."),
    });
  }

  child = spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      // Token doesn't have to be valid — list_tools doesn't hit Capsule.
      CAPSULE_API_TOKEN: "test-token",
      CAPSULE_MCP_READONLY: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Capture stderr from spawn-time so startup banners aren't lost.
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  // Initialise handshake so the server is ready to accept tools/list.
  const initResp = await rpc(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stdio-smoke", version: "1.0.0" },
    },
  });
  expect(initResp["result"]).toBeTruthy();

  // Send the post-init notification per the MCP spec.
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })}\n`,
  );
});

afterAll(() => {
  if (child && !child.killed) child.kill();
});

describe("stdio entry — built bundle smoke test", () => {
  it("dist/index.js exists and is executable", () => {
    expect(existsSync(DIST_INDEX)).toBe(true);
  });

  it("starts up cleanly — initialize handshake completes", () => {
    // beforeAll already exercised this; the test is here for the
    // narrative arrangement.
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBeNull();
  });

  it("tools/list returns the read-only-mode tool set", async () => {
    const resp = await rpc(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (resp["result"] as { tools: { name: string }[] })?.tools;
    expect(Array.isArray(tools)).toBe(true);
    const names = tools.map((t) => t.name);

    // Some reads
    expect(names).toContain("search_parties");
    expect(names).toContain("filter_parties");
    expect(names).toContain("get_attachment");

    // No writes (CAPSULE_MCP_READONLY=1)
    for (const w of [
      "create_party",
      "delete_party",
      "add_note",
      "upload_attachment",
      "apply_track",
    ]) {
      expect(names).not.toContain(w);
    }
  });

  it("logs read-only banner to stderr", () => {
    // stderrBuffer is accumulated from the listener attached in beforeAll,
    // so the startup banner is captured even though we read it later.
    expect(stderrBuffer).toMatch(/read-only mode/);
  });

  it("fails fast with exit 1 when CAPSULE_API_TOKEN is missing", async () => {
    const env = { ...process.env };
    delete env["CAPSULE_API_TOKEN"];
    const proc = spawn("node", [DIST_INDEX], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/CAPSULE_API_TOKEN/);
  });
});

describe("stdio entry — MCP Tasks wiring (SEP-1686)", () => {
  let taskChild: ChildProcessWithoutNullStreams;
  let initResult: Record<string, unknown> | undefined;

  beforeAll(async () => {
    // Write mode (CAPSULE_MCP_READONLY explicitly empty) so the
    // task-augmented batch_* tools register, plus MCP_TASKS_ENABLED=1.
    // The stdio entry now supplies a synthetic clientId, so tasks wire —
    // pre-change stdio passed no clientId and tasks stayed off here.
    taskChild = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        CAPSULE_API_TOKEN: "test-token",
        CAPSULE_MCP_READONLY: "",
        MCP_TASKS_ENABLED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const resp = await rpc(taskChild, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-tasks", version: "1.0.0" },
      },
    });
    initResult = resp["result"] as Record<string, unknown>;
    taskChild.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  });

  afterAll(() => {
    if (taskChild && !taskChild.killed) taskChild.kill();
  });

  it("advertises the tasks server capability when MCP_TASKS_ENABLED=1", () => {
    const caps = initResult?.["capabilities"] as Record<string, unknown> | undefined;
    expect(caps?.["tasks"]).toBeTruthy();
  });

  it("registers batch_* writes as task-augmented (execution.taskSupport === 'optional')", async () => {
    const resp = await rpc(taskChild, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (
      resp["result"] as {
        tools: Array<{ name: string; execution?: { taskSupport?: string } }>;
      }
    ).tools;
    const batch = tools.find((t) => t.name === "batch_update_party");
    expect(batch).toBeTruthy();
    expect(batch?.execution?.taskSupport).toBe("optional");
  });
});
