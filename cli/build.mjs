// Bundles the CLI into dist/cli.js, including the core shared with the GitHub App
// (supabase/functions/_shared). npm dependencies stay external and install with the package.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  // Ignore tsconfig: its zod "paths" entry is only for type checking and would make esbuild bundle zod
  tsconfigRaw: {},
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});
