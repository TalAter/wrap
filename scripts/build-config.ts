// Bun's --external doesn't work in compiled binaries (no node_modules to
// resolve from), so we stub Ink's `react-devtools-core` import via a plugin.
export const stubReactDevtoolsPlugin: Bun.BunPlugin = {
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
