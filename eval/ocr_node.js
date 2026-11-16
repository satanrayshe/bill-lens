// Run the app's OCR step (same preprocessing, same Tesseract.js engine and
// language model) over a folder of bill photos and cache the line output.
//
//   node eval/ocr_node.js eval/bills/test [--psm 6]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import Tesseract from "tesseract.js";
import { cleanForOcr, limitSize } from "../app/src/core/preprocess.js";
import { flattenBlocks } from "../app/src/core/ocrlines.js";

const require = createRequire(import.meta.url);
const dir = process.argv[2];
const psmArg = process.argv.indexOf("--psm");
const PSM = psmArg > 0 ? process.argv[psmArg + 1] : "6";
const force = process.argv.includes("--force");
const langPath = path.dirname(require.resolve("@tesseract.js-data/eng/package.json")) + "/4.0.0_best_int";

export async function makeWorker() {
  const worker = await Tesseract.createWorker("eng", 1, { langPath, gzip: true, cachePath: path.resolve(".tess-cache") });
  await worker.setParameters({ tessedit_pageseg_mode: PSM, preserve_interword_spaces: "1", user_defined_dpi: "300" });
  return worker;
}

export function loadRgba(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith(".png")) {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { data: j.data, width: j.width, height: j.height };
}

export function toPng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png);
}

async function main() {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
  const outDir = path.join(dir, `ocr-psm${PSM}`);
  fs.mkdirSync(outDir, { recursive: true });
  const worker = await makeWorker();
  let t0 = Date.now();
  for (const f of files) {
    const out = path.join(outDir, f.replace(".jpg", ".json"));
    if (fs.existsSync(out) && !force) continue;
    const img = cleanForOcr(limitSize(loadRgba(path.join(dir, f)), 2000));
    const t = Date.now();
    const res = await worker.recognize(toPng(img), { rotateAuto: true }, { blocks: true, text: true });
    const lines = flattenBlocks(res.data);
    fs.writeFileSync(out, JSON.stringify({ file: f, width: img.width, height: img.height, ms: Date.now() - t, text: res.data.text, lines }));
    console.log(f, `${Date.now() - t} ms`, lines.length, "lines");
  }
  await worker.terminate();
  console.log("done in", ((Date.now() - t0) / 1000).toFixed(1), "s");
}

if (process.argv[1] && process.argv[1].endsWith("ocr_node.js")) main();
