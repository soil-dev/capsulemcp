import { defineConfig } from "tsup";

// Two separate configs so the shebang banner is only applied to the
// stdio entry (which IS invoked as a CLI by Claude Desktop / npx) and
// NOT to the HTTP entry (which runs as `node dist/http.js`, no shebang
// needed). Both share the rest of their settings.

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node22",
    outDir: "dist",
    clean: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: ["src/http.ts"],
    format: ["esm"],
    target: "node22",
    outDir: "dist",
    // First config already cleaned; don't clean again or we'd wipe its output.
    clean: false,
    // No banner — invoked as `node dist/http.js`.
  },
]);
