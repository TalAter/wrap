import { stubReactDevtoolsPlugin } from "./build-config.ts";

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  compile: { outfile: "wrap" },
  plugins: [stubReactDevtoolsPlugin],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
