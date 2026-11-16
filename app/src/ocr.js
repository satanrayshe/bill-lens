// In-browser OCR with Tesseract.js (LSTM English model, self-hosted, cached
// in IndexedDB by Tesseract and in the service worker cache for offline use).
import Tesseract from "tesseract.js";
import { flattenBlocks } from "./core/ocrlines.js";

let workerPromise = null;
let progressCb = () => {};

export function onOcrProgress(cb) {
  progressCb = cb;
}

export function getOcrWorker() {
  if (!workerPromise) {
    const base = new URL(import.meta.env.BASE_URL, location.href).href;
    workerPromise = Tesseract.createWorker("eng", 1, {
      workerPath: base + "tesseract/worker.min.js",
      corePath: base + "tesseract/",
      langPath: base + "tesseract/lang",
      gzip: true,
      workerBlobURL: false,
      logger: (m) => progressCb(m),
    }).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1", user_defined_dpi: "300" });
      return w;
    });
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** @param canvas HTMLCanvasElement holding the cleaned image */
export async function recognise(canvas) {
  const w = await getOcrWorker();
  const res = await w.recognize(canvas, { rotateAuto: true }, { blocks: true, text: true });
  return { lines: flattenBlocks(res.data), text: res.data.text };
}
