// Build training data for the matcher's scoring model.
//   node eval/export_match_pairs.js > data/processed/match_pairs.jsonl
// Queries come from (a) real OCR output of the TRAIN split bills only and
// (b) brand names with simulated OCR noise. Never uses dev or test bills.
import fs from "node:fs";
import path from "node:path";
import { loadData } from "./load_data.js";
import { Matcher, FEATURES } from "../app/src/core/matcher.js";
import { parseBill } from "../app/src/core/parse.js";
import { similarity, normName } from "../app/src/core/textnorm.js";

const data = loadData();
const m = new Matcher(data.brands);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const out = [];

function emit(qid, name, truthLabel, truthForm, pack) {
  const { cands } = m.candidates(name, { pack });
  if (!cands.length) return;
  const base = (f) => f.replace("_mr", "");
  let anyPos = false;
  const rows = [];
  for (const c of cands) {
    const row = m.rows[c.row];
    const pos = row[0].toLowerCase() === truthLabel.toLowerCase() && base(m.forms[row[1]]) === base(truthForm);
    anyPos ||= pos;
    rows.push({ qid, y: pos ? 1 : 0, x: FEATURES.map((k) => +c.f[k].toFixed(4)) });
  }
  // keep all positives and up to 40 hardest-looking negatives (by famSim) per query
  const pos = rows.filter((r) => r.y), neg = rows.filter((r) => !r.y).sort((a, b) => b.x[0] - a.x[0]).slice(0, 40);
  if (anyPos) out.push(...pos, ...neg);
}

// (a) real OCR from train bills
const dir = "eval/bills/train";
const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8"));
let qid = 0, real = 0;
for (const b of truth) {
  const ocr = JSON.parse(fs.readFileSync(path.join(dir, "ocr-psm6", `${b.id}.json`), "utf8"));
  const parsed = parseBill(ocr.lines);
  for (const gt of b.items) {
    let best = null, bs = 0.4;
    for (const it of parsed.items) {
      const s = similarity(normName(it.name), normName(gt.label));
      if (s > bs) { bs = s; best = it; }
    }
    if (best) { emit(qid++, best.name, gt.label, gt.form, best.pack); real++; }
  }
}

// (b) simulated OCR noise on random brands (tablets/capsules)
const CONF = { o: "0", 0: "O", i: "l", l: "1", 1: "l", s: "5", 5: "S", b: "8", 8: "B", e: "c", c: "e", m: "rn", n: "m", u: "v", g: "q", z: "2", 2: "Z" };
function noisy(s) {
  let o = "";
  for (const ch of s) {
    const r = rnd();
    const low = ch.toLowerCase();
    if (r < 0.035 && CONF[low]) o += CONF[low];
    else if (r < 0.045) continue;
    else if (r < 0.052) o += ch + " ";
    else o += ch;
  }
  return o.replace(/\s+/g, " ");
}
const tabRows = data.brands.rows.filter((r) => ["tab", "cap", "tab_mr", "cap_mr"].includes(data.brands.forms[r[1]]));
let synth = 0;
for (let i = 0; i < 4000; i++) {
  const r = pick(tabRows);
  const form = data.brands.forms[r[1]];
  const fw = form.startsWith("cap") ? "CAP" : "TAB";
  const style = rnd();
  let name = style < 0.5 ? `${r[0].toUpperCase()} ${fw}` : style < 0.8 ? `${r[0]} ${fw[0] + fw.slice(1).toLowerCase()}` : `${r[0].toUpperCase()} ${fw} ${r[3]}'S`;
  name = noisy(name);
  emit(qid++, name, r[0], form, null);
  synth++;
}
for (const r of out) process.stdout.write(JSON.stringify(r) + "\n");
console.error(`queries: real ${real}, synthetic ${synth}; rows ${out.length}; features ${FEATURES.join(",")}`);
