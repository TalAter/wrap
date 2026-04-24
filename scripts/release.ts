#!/usr/bin/env bun
// Stamps the currently-installed Bun version into `.bun-version` so CI builds
// the release on the same Bun you tested with. Run as `bun run release <ver>`.
// Leaves pushing to the user.

import { $ } from "bun";
import pkg from "../package.json";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bun run release <version>  (e.g. 0.0.2 or 0.0.2-rc.1)");
  process.exit(1);
}

const status = (await $`git status --porcelain`.text()).trim();
if (status) {
  console.error("Working tree not clean. Commit or stash first.");
  process.exit(1);
}

const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main") {
  console.error(`Releases cut from \`main\`, currently on \`${branch}\`.`);
  process.exit(1);
}

const tag = `v${version}`;
const existing = await $`git tag -l ${tag}`.text();
if (existing.trim()) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

const bunVersion = Bun.version;

pkg.version = version;
await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
await Bun.write(".bun-version", `${bunVersion}\n`);

await $`git add package.json .bun-version`;
await $`git commit -m ${`release ${tag}`}`;
await $`git tag ${tag}`;

console.log(`Tagged ${tag} with Bun ${bunVersion}.`);
console.log(`Next: git push && git push origin ${tag}`);
