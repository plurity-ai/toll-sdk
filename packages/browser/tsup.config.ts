import { defineConfig } from "tsup";

export default defineConfig({
  entry: { toll: "src/index.ts" },
  format: ["iife"],
  globalName: "PlurityToll",
  target: "es2017",
  minify: true,
  clean: true,
  dts: false,
  sourcemap: false,
  outDir: "dist",
  outExtension: () => ({ js: ".js" }),
});
