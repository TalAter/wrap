import { stubReactDevtoolsPlugin } from "./build-config.ts";

const target = process.argv[2] ?? process.env.BUN_BUILD_TARGET;
if (!target) {
  console.error(
    "build-release: target required (argv[2] or BUN_BUILD_TARGET).\n" +
      "  e.g. bun run scripts/build-release.ts bun-darwin-arm64",
  );
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  compile: { target: target as Bun.Build.CompileTarget, outfile: "wrap" },
  plugins: [stubReactDevtoolsPlugin],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
