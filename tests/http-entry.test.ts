/**
 * HTTP entry smoke test. Spawns the built `dist/http.js` and checks what
 * only the real process can show: where the socket actually binds, and
 * that a failed bind exits non-zero. `resolveListenHost` itself is
 * unit-tested in http-config.test.ts; these pin that `src/http.ts` wires
 * it into `app.listen` (the 2026-10 security review reproduced
 * insecure-auto-approve mode answering on the machine's LAN address).
 *
 * The startup token probe is pointed at a refused loopback port
 * (CAPSULE_API_BASE_URL) so no test here touches the network.
 */

import { type ChildProcessWithoutNullStreams, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_HTTP = join(__dirname, "..", "dist", "http.js");

let child: ChildProcessWithoutNullStreams | undefined;

beforeAll(() => {
  if (!existsSync(DIST_HTTP)) {
    execSync("npm run build", { stdio: "inherit", cwd: join(__dirname, "..") });
  }
});

afterEach(() => {
  child?.kill();
  child = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** The parent's env minus anything that could change the mode under test. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("MCP_") && !k.startsWith("CAPSULE_") && k !== "PORT") env[k] = v;
  }
  return {
    ...env,
    CAPSULE_API_TOKEN: "test-token",
    CAPSULE_API_BASE_URL: "http://127.0.0.1:9",
    CAPSULE_MCP_READONLY: "1",
    MCP_OAUTH_SIGNING_KEY: "a".repeat(64),
    ...extra,
  };
}

/** Resolve with the startup line, or with the exit code if the process dies first. */
function start(
  env: NodeJS.ProcessEnv,
): Promise<{ line?: string; exitCode?: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [DIST_HTTP], { env });
    child = proc;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`no startup line; stderr: ${stderr}`)), 10_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split("\n").find((l) => l.includes("listening on"));
      if (line) {
        clearTimeout(timer);
        resolve({ line, stderr });
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr });
    });
  });
}

function tryConnect(host: string, port: number): Promise<"connected" | "refused"> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", () => resolve("refused"));
    socket.once("timeout", () => {
      socket.destroy();
      resolve("refused");
    });
  });
}

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

describe("dist/http.js bind address", () => {
  it("insecure-auto-approve with a localhost URL listens on 127.0.0.1 only", async () => {
    const port = await freePort();
    const started = await start(
      cleanEnv({
        PORT: String(port),
        PUBLIC_BASE_URL: `http://localhost:${port}`,
        MCP_OAUTH_INSECURE_AUTO_APPROVE: "1",
      }),
    );
    expect(started.line, started.stderr).toContain(`listening on 127.0.0.1:${port}`);
    expect(await tryConnect("127.0.0.1", port)).toBe("connected");
    if (lanAddress) expect(await tryConnect(lanAddress, port)).toBe("refused");
  }, 20_000);

  it("static-client mode keeps listening on every interface", async () => {
    const port = await freePort();
    const started = await start(
      cleanEnv({
        PORT: String(port),
        PUBLIC_BASE_URL: "https://mcp.example.com",
        MCP_OAUTH_CLIENT_ID: "client-id",
        MCP_OAUTH_CLIENT_SECRET: "client-secret-of-sufficient-length",
      }),
    );
    // The line reports the socket's real address: the dual-stack wildcard.
    expect(started.line, started.stderr).toMatch(
      new RegExp(`(\\[::\\]|0\\.0\\.0\\.0):${port} \\(all interfaces\\)`),
    );
    if (lanAddress) expect(await tryConnect(lanAddress, port)).toBe("connected");
  }, 20_000);

  it("a bind failure exits non-zero and says why, instead of claiming to listen", async () => {
    // Hold the port so the child's bind fails with EADDRINUSE — the
    // same on every OS, unlike binding an address the host lacks.
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
    const { port } = holder.address() as { port: number };
    try {
      const started = await start(
        cleanEnv({
          PORT: String(port),
          PUBLIC_BASE_URL: `http://localhost:${port}`,
          MCP_OAUTH_INSECURE_AUTO_APPROVE: "1",
        }),
      );
      expect(started.line).toBeUndefined();
      expect(started.exitCode).toBe(1);
      expect(started.stderr).toMatch(
        new RegExp(`cannot listen on 127\\.0\\.0\\.1:${port}: .*EADDRINUSE`),
      );
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 20_000);
});
