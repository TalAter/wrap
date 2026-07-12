import { mkdirSync } from "node:fs";

// Bun's --external doesn't work in compiled binaries (no node_modules to
// resolve from), so we stub Ink's `react-devtools-core` import via a plugin.
const stubReactDevtoolsPlugin: Bun.BunPlugin = {
  name: "stub-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {}",
      loader: "js",
    }));
  },
};

const NAME = "wrap";

// WRAP_BUILD_TARGET set (release CI): build that single target to a root
// ./wrap binary. Unset (local dev): build both dev-sandbox targets into
// dist/<name>-<os>-<arch> (the dev sandbox mounts the linux one; the `w`
// alias points at the darwin one). `bun-` is stripped for friendlier filenames.
const releaseTarget = process.env.WRAP_BUILD_TARGET;
const TARGETS = releaseTarget ? [releaseTarget] : ["bun-darwin-arm64", "bun-linux-arm64"];

const outfileFor = (target: string) => (releaseTarget ? NAME : `dist/${NAME}-${target.slice(4)}`);

if (!releaseTarget) mkdirSync("dist", { recursive: true });

for (const target of TARGETS) {
  const result = await Bun.build({
    entrypoints: ["src/index.ts"],
    compile: {
      outfile: outfileFor(target),
      target: target as Bun.Build.CompileTarget,
    },
    plugins: [stubReactDevtoolsPlugin],
  });

  if (!result.success) {
    console.error(`Build failed (${target}):`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
