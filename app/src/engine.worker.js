// Background worker: loads the price lists and brand table, builds the matcher
// index, cleans photos for OCR and runs the bill analysis, so the page stays
// responsive on slower phones.
import { Engine } from "./core/pipeline.js";
import { cleanForOcr, limitSize } from "./core/preprocess.js";

let engine = null;
let base = "/";

async function fetchJson(path, label) {
  const res = await fetch(new URL(path, base));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const total = +res.headers.get("content-length") || 0;
  if (!res.body || !total) return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    self.postMessage({ type: "progress", label, got, total });
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

async function init({ baseUrl }) {
  base = baseUrl;
  const [brands, nppa, pmbjp, model, meta] = await Promise.all([
    fetchJson("data/brands.json", "brands"),
    fetchJson("data/nppa.json", "nppa"),
    fetchJson("data/pmbjp.json", "pmbjp"),
    fetchJson("models/matcher.json", "model"),
    fetchJson("data/meta.json", "meta"),
  ]);
  engine = new Engine({ brands, nppa, pmbjp, weights: model.weights });
  return { brands: brands.rows.length, nppa: nppa.length, pmbjp: pmbjp.length, meta, model: { trained_on: model.trained_on, validation_top1: model.validation_top1 } };
}

const handlers = {
  init,
  clean({ image }) {
    const img = cleanForOcr(limitSize(image, 2000));
    return { image: img, transfer: [img.data.buffer] };
  },
  analyse({ lines }) {
    return engine.analyseLines(lines);
  },
  item({ item, hint, forced }) {
    return engine.analyseItem(item, hint, forced);
  },
  search({ text }) {
    return engine.matcher.match(text).alternatives;
  },
  summary({ lines, billTotal }) {
    return engine.recheck(lines, billTotal);
  },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    const out = await handlers[type](payload || {});
    const transfer = out && out.transfer ? out.transfer : [];
    if (out && out.transfer) delete out.transfer;
    self.postMessage({ id, ok: true, out }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack ? err.stack : err) });
  }
};
