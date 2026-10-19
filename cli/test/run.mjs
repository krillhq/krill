// Bundles and runs every test (*.test.ts); none of them call a model or GitHub.
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

for (const file of fs.readdirSync("test").filter((f) => f.endsWith(".test.ts"))) {
  const outfile = `test/.out/${file.replace(/\.ts$/, ".mjs")}`;
  buildSync({ entryPoints: [`test/${file}`], bundle: true, platform: "node", format: "esm", packages: "external", outfile });
  execFileSync(process.execPath, [outfile], { stdio: "inherit" });
}
