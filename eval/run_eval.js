// End-to-end evaluation on synthetic bill photos with ground truth.
//
//   node eval/run_eval.js eval/bills/test [--json eval/results/test.json]
//
// Requires OCR output cached by eval/ocr_node.js (same engine as the app).
// Metrics:
//   line extraction   - a ground-truth line counts as extracted when a parsed
//                       line has the same quantity and amount (to the paisa)
//   medicine match    - for extracted lines, top-1 salt+strength+form equals truth;
//                       brand-exact is the stricter "same brand label"
//   overcharge        - line-level precision / recall of the "possible
//                       overcharge" flag, end to end from the photo (missed
//                       lines count as not flagged)
import fs from "node:fs";
import path from "node:path";
import { loadData } from "./load_data.js";
import { Engine } from "../app/src/core/pipeline.js";
import { similarity, normName } from "../app/src/core/textnorm.js";

const dir = process.argv[2];
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const psm = process.argv.includes("--psm") ? process.argv[process.argv.indexOf("--psm") + 1] : "6";
const verbose = process.argv.includes("-v");

const eng = new Engine(loadData());
const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8"));

function newAgg() {
  return { bills: 0, gtLines: 0, parsedLines: 0, extracted: 0, aligned: 0, keyOk: 0, brandOk: 0, tp: 0, fp: 0, fn: 0, tn: 0,
    billTp: 0, billFp: 0, billFn: 0, billTn: 0, withGeneric: 0, ceilingKnownGt: 0, ceilingFound: 0, ms: 0 };
}
const agg = { all: newAgg() };
const errors = [];

for (const b of truth) {
  const ocrFile = path.join(dir, `ocr-psm${psm}`, `${b.id}.json`);
  const ocr = JSON.parse(fs.readFileSync(ocrFile, "utf8"));
  const res = eng.analyseLines(ocr.lines);
  const buckets = [agg.all, (agg[b.template] ||= newAgg())];
  const used = new Set();
  const align = b.items.map((gt) => {
    let best = -1, bs = -1;
    res.lines.forEach((pl, j) => {
      if (used.has(j)) return;
      const it = pl.item;
      if (it.amount == null || Math.abs(it.amount - gt.amount) > 0.011 || it.qty !== gt.qty) return;
      const s = similarity(normName(it.name), normName(gt.label));
      if (s > bs) { bs = s; best = j; }
    });
    if (best >= 0) used.add(best);
    return best;
  });
  // parsed lines that do not correspond to any ground-truth line
  const unaligned = res.lines.filter((_, j) => !used.has(j));
  let billGt = false, billPred = false;
  b.items.forEach((gt, i) => {
    const j = align[i];
    const pl = j >= 0 ? res.lines[j] : null;
    const flagged = !!(pl && pl.check.flags.length);
    billGt ||= gt.overcharged;
    billPred ||= flagged;
    for (const a of buckets) {
      a.gtLines++;
      if (pl) {
        a.extracted++;
        if (pl.match && pl.match.key === gt.key && pl.match.form.replace("_mr", "") === gt.form.replace("_mr", "")) a.keyOk++;
        else if (a === agg.all) errors.push({ bill: b.id, kind: "match", ocr: pl.item.name, got: pl.match ? `${pl.match.label} | ${pl.match.key}` : null, want: `${gt.label} | ${gt.key}` });
        if (pl.match && pl.match.label && pl.match.label.toLowerCase() === gt.label.toLowerCase()) a.brandOk++;
        if (pl.check.generic) a.withGeneric++;
      } else if (a === agg.all) errors.push({ bill: b.id, kind: "missed", want: `${gt.label} q=${gt.qty} a=${gt.amount}` });
      if (gt.ceiling) {
        a.ceilingKnownGt++;
        if (pl && pl.check.ceiling) a.ceilingFound++;
      }
      if (gt.overcharged && flagged) a.tp++;
      else if (!gt.overcharged && flagged) { a.fp++; }
      else if (gt.overcharged && !flagged) a.fn++;
      else a.tn++;
    }
    if (gt.overcharged !== flagged) errors.push({ bill: b.id, kind: flagged ? "false-flag" : "missed-flag", name: gt.label, got: pl ? pl.check : null });
  });
  for (const pl of unaligned) {
    if (pl.check.flags.length) {
      billPred = true;
      for (const a of buckets) a.fp++;
      errors.push({ bill: b.id, kind: "flag-on-unaligned", name: pl.item.name });
    }
  }
  for (const a of buckets) {
    a.bills++;
    a.parsedLines += res.lines.length;
    a.aligned += align.filter((x) => x >= 0).length;
    a.ms += ocr.ms;
    if (billGt && billPred) a.billTp++;
    else if (!billGt && billPred) a.billFp++;
    else if (billGt && !billPred) a.billFn++;
    else a.billTn++;
  }
}

const pct = (a, b) => (b ? (100 * a) / b : NaN);
function report(name, a) {
  return {
    split: name,
    bills: a.bills,
    gt_lines: a.gtLines,
    line_extraction_recall: pct(a.extracted, a.gtLines),
    line_extraction_precision: pct(a.aligned, a.parsedLines),
    medicine_match_acc_salt_strength_form: pct(a.keyOk, a.extracted),
    medicine_match_acc_brand_exact: pct(a.brandOk, a.extracted),
    ceiling_lookup_recall: pct(a.ceilingFound, a.ceilingKnownGt),
    overcharge_lines: a.tp + a.fn,
    overcharge_precision: pct(a.tp, a.tp + a.fp),
    overcharge_recall: pct(a.tp, a.tp + a.fn),
    tp: a.tp, fp: a.fp, fn: a.fn,
    bill_level_precision: pct(a.billTp, a.billTp + a.billFp),
    bill_level_recall: pct(a.billTp, a.billTp + a.billFn),
    lines_with_generic_pct: pct(a.withGeneric, a.extracted),
    avg_ocr_ms: a.ms / Math.max(1, a.bills),
  };
}
const out = Object.entries(agg).map(([k, a]) => report(k, a));
const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
const cols = Object.keys(out[0]);
console.log(cols.join("\t"));
for (const r of out) console.log(cols.map((c) => fmt(r[c])).join("\t"));
if (verbose) for (const e of errors) console.log(JSON.stringify(e).slice(0, 400));
if (jsonOut) {
  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify({ results: out, errors }, null, 1));
}
