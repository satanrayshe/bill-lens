// Copy the OCR engine files into app/public so the site can run without any CDN.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const dest = path.resolve("app/public/tesseract");
fs.mkdirSync(path.join(dest, "lang"), { recursive: true });
const tjs = path.dirname(require.resolve("tesseract.js/package.json"));
const core = path.dirname(require.resolve("tesseract.js-core/package.json"));
const eng = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
const files = [
  [path.join(tjs, "dist/worker.min.js"), "worker.min.js"],
  ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"].map((f) => [path.join(core, f), f]),
  [path.join(eng, "4.0.0_best_int/eng.traineddata.gz"), "lang/eng.traineddata.gz"],
];
for (const [src, rel] of files) {
  fs.copyFileSync(src, path.join(dest, rel));
  console.log("copied", rel, (fs.statSync(src).size / 1e6).toFixed(2), "MB");
}
