// Stamps the locally-installed Bun into `.bun-version` so CI rebuilds with
// the same Bun the release author tested on.

import { $ } from "bun";
import pkg from "../package.json";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
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
const staged = (await $`git diff --cached --name-only`.text()).trim();
if (staged) {
  await $`git commit -m ${`release ${tag}`}`;
}
await $`git tag ${tag}`;

console.log(`Tagged ${tag} at HEAD with Bun ${bunVersion}.`);
console.log(`Next: git push origin main && git push origin ${tag}`);
