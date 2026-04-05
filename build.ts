/**
 * Bun's --external doesn't work in compiled binaries (no node_modules to
 * resolve from), so we use the JS API to stub out Ink's react-devtools-core
 * import via a plugin.
 */

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  compile: { outfile: "wrap" },
  plugins: [
    {
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
    },
  ],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
