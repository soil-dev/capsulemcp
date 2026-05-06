import { defineConfig } from "tsup";

export default defineConfig({
  // index.ts = stdio entry (npx-installed bin)
  // http.ts  = HTTP entry (Cloud Run / remote-connector deployments)
  entry: ["src/index.ts", "src/http.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
