import { copyFile, readFile } from "node:fs/promises";
import { defineConfig } from "tsup";

const { version } = JSON.parse(await readFile("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: { cli: "src/cli.tsx" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  // Single source of truth for `ccpool --version`: injected from package.json.
  define: { __CLI_VERSION__: JSON.stringify(version) },
  // Bundle the internal workspace packages (they are devDependencies) into the
  // single published `ccpool` package; keep real runtime deps external so npm
  // installs them normally.
  noExternal: [/^@ccpool\//],
  // The entry file already carries `#!/usr/bin/env node`; tsup preserves it.
  // Pull the canonical README/LICENSE from the repo root into the package root
  // at build time so they ship in the tarball without committing duplicates
  // here. They must land at the package root (not dist) — npm only renders the
  // README and recognizes the LICENSE from there. Both are gitignored.
  async onSuccess() {
    await Promise.all([
      copyFile("../../README.md", "README.md"),
      copyFile("../../LICENSE", "LICENSE"),
    ]);
  },
});
