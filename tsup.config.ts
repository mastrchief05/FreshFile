import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    cli: "src/cli/cli.ts"
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  platform: "node"
});
