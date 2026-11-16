// Medicine-name matcher: OCR'd bill text -> brand row -> salt + strength key.
//
// Stage 1 (recall): character-trigram retrieval over brand "family" words
//   (the first word of each brand, ~130k of them), tolerant of OCR noise.
// Stage 2 (precision): every brand variant in the retrieved families is scored
//   by a small logistic model over hand-built features (fuzzy brand-word
//   similarity with OCR-confusion-aware edit costs, strength numbers, dosage
//   form, pack size, unexplained extra words). The weights are learned from
//   OCR output of synthetic training bills plus OCR-style noise; see
//   scripts/train_matcher.py. A generic-name path handles lines that print the
//   salt instead of a brand ("PARACETAMOL 500MG TAB").

import { analyseName, normName, similarity, trigrams, dice } from "./textnorm.js";

export const FEATURES = [
  "famSim", "famExact", "wordDice", "labelNumsFound", "queryNumsExplained", "extraLabelWords",
  "extraQueryWords", "formAgree", "formConflict", "packAgree", "packConflict", "lenRatio", "famPrefix",
];

const DEFAULT_WEIGHTS = {
  bias: -6, famSim: 7, famExact: 1.5, wordDice: 2, labelNumsFound: 2.5, queryNumsExplained: 1.5, extraLabelWords: -2,
  extraQueryWords: -0.8, formAgree: 0.6, formConflict: -1.5, packAgree: 0.4, packConflict: -0.2, lenRatio: 0.5, famPrefix: 0.5,
};

// Brand family = first word with 3+ letters ("L Sudo M" -> "sudo", "Dolo 650" -> "dolo").
export function familyWord(words) {
  return words.find((w) => /^[a-z][a-z0-9-]{2,}$/.test(w)) || words[0] || "";
}

function labelInfo(label) {
  const a = analyseName(label);
  return { norm: a.norm, fam: familyWord(a.words) || a.norm.split(" ")[0] || "", words: a.words, nums: a.nums, strengths: a.strengths };
}

function strengthMg(s) {
  if (!s.u) return [s.v];
  if (s.u === "mcg") return [s.v / 1000];
  if (s.u === "g" || s.u === "gm") return [s.v * 1000];
  return [s.v];
}

function keyStrengths(key) {
  // "amoxicillin 500mg + clavulanic acid 125mg" -> [500, 125]
  const out = [];
  for (const part of key.split(" + ")) {
    const m = part.match(/(\d+(?:\.\d+)?)(mg|iu|%)/);
    if (m) out.push(+m[1]);
  }
  return out;
}

function keySalts(key) {
  return key.split(" + ").map((p) => p.replace(/\s+\d+(?:\.\d+)?(mg|iu|%)(\/(ml|g))?$/, "").trim());
}

export class Matcher {
  constructor(brands, weights) {
    this.forms = brands.forms;
    this.comps = brands.comps;
    this.rows = brands.rows; // [label, formIdx, compIdx, packCount, packMl]
    this.w = weights || DEFAULT_WEIGHTS;
    this._build();
  }

  _build() {
    const famId = new Map();
    this.famNames = [];
    this.famRows = [];
    this.rowFam = new Int32Array(this.rows.length);
    for (let i = 0; i < this.rows.length; i++) {
      const fam = familyWord(analyseName(this.rows[i][0]).words) || normName(this.rows[i][0]);
      let id = famId.get(fam);
      if (id === undefined) {
        id = this.famNames.length;
        famId.set(fam, id);
        this.famNames.push(fam);
        this.famRows.push([]);
      }
      this.famRows[id].push(i);
      this.rowFam[i] = id;
    }
    const idx = new Map();
    for (let f = 0; f < this.famNames.length; f++) {
      for (const g of new Set(trigrams(this.famNames[f]))) {
        let arr = idx.get(g);
        if (!arr) idx.set(g, (arr = []));
        arr.push(f);
      }
    }
    this.tri = idx;
    this.famTriCount = this.famNames.map((f) => new Set(trigrams(f)).size);
    // generic-name vocabulary
    const salts = new Set();
    for (const k of this.comps) for (const s of keySalts(k)) salts.add(s);
    this.salts = [...salts];
    this.compIndex = new Map(this.comps.map((k, i) => [k, i]));
  }

  _families(word, k = 40) {
    const grams = [...new Set(trigrams(word))];
    const counts = new Map();
    for (const g of grams) {
      const arr = this.tri.get(g);
      if (!arr || arr.length > 20000) continue;
      for (const f of arr) counts.set(f, (counts.get(f) || 0) + 1);
    }
    const scored = [];
    for (const [f, c] of counts) {
      const d = (2 * c) / (grams.length + this.famTriCount[f]);
      if (d > 0.25) scored.push([f, d]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, k).map((x) => x[0]);
  }

  features(q, rowIdx, cache) {
    const row = this.rows[rowIdx];
    const info = cache.get(rowIdx) || labelInfo(row[0]);
    cache.set(rowIdx, info);
    const form = this.forms[row[1]];
    const key = this.comps[row[2]];
    const qi = Math.max(0, q.words.indexOf(familyWord(q.words)));
    const qFam = q.words[qi] || "";
    const famSim = Math.max(similarity(qFam, info.fam), q.words[qi + 1] ? similarity(qFam + q.words[qi + 1], info.fam) : 0, q.words[0] !== qFam ? similarity(q.words[0], info.fam) : 0);
    const qAlpha = q.words.join(" ");
    const lAlpha = info.words.join(" ");
    const wordDice = qAlpha && lAlpha ? dice(qAlpha, lAlpha) : 0;
    const qNums = new Set([...q.nums, ...q.altNums].map(String));
    const qMg = new Set(q.strengths.flatMap(strengthMg).map((v) => +v.toFixed(4)));
    const lNumsFound = info.nums.length ? info.nums.filter((n) => qNums.has(String(n))).length / info.nums.length : 0.5;
    const kStr = keyStrengths(key).map((v) => +v.toFixed(4));
    const explained = q.strengths.length
      ? q.strengths.filter((s) => info.nums.includes(s.v) || strengthMg(s).some((v) => kStr.includes(+v.toFixed(4)))).length / q.strengths.length
      : 0.5;
    const extraL = info.words.slice(1).filter((w) => !q.words.some((qw) => similarity(qw, w) >= 0.75)).length;
    const altOk = (w) => /^[soilbz]{1,3}$/.test(w) && info.nums.some((n) => q.altNums.includes(n));
    const extraQ = q.words.slice(1).filter((w) => !altOk(w) && !info.words.some((lw) => similarity(lw, w) >= 0.75)).length;
    let formAgree = 0, formConflict = 0;
    if (q.form) {
      const base = (f) => f.replace("_mr", "");
      if (q.form === form) formAgree = 1;
      else if (base(q.form) === base(form)) formAgree = 0.5;
      else formConflict = 1;
    }
    let packAgree = 0, packConflict = 0;
    if (q.pack && row[3]) {
      if (q.pack === row[3]) packAgree = 1;
      else packConflict = 1;
    }
    const lenRatio = Math.min(q.norm.length, info.norm.length) / Math.max(q.norm.length, info.norm.length, 1);
    const famPrefix = qFam.length >= 3 && info.fam.startsWith(qFam.slice(0, 3)) ? 1 : 0;
    void qMg;
    return {
      famSim, famExact: qFam === info.fam ? 1 : 0, wordDice, labelNumsFound: lNumsFound, queryNumsExplained: explained,
      extraLabelWords: extraL, extraQueryWords: extraQ, formAgree, formConflict, packAgree, packConflict, lenRatio, famPrefix,
    };
  }

  score(f) {
    let z = this.w.bias || 0;
    for (const k of FEATURES) z += (this.w[k] || 0) * f[k];
    return 1 / (1 + Math.exp(-z));
  }

  /** Pack sizes available for the same brand label, composition and form. */
  packsFor(rowIdx) {
    const r = this.rows[rowIdx];
    const lab = r[0].toLowerCase();
    const packs = new Set();
    for (const i of this.famRows[this.rowFam[rowIdx]]) {
      const o = this.rows[i];
      if (o[0].toLowerCase() === lab && o[1] === r[1] && o[2] === r[2] && o[3]) packs.add(o[3]);
    }
    return [...packs];
  }

  /** Candidate rows for a bill name, with features (used for training). */
  candidates(name, opts = {}) {
    const q = analyseName(name);
    if (opts.pack && !q.pack) q.pack = opts.pack;
    if (!q.words.length) return { q, cands: [] };
    const fw = familyWord(q.words);
    const fi = Math.max(0, q.words.indexOf(fw));
    const fams = new Set(this._families(fw));
    if (q.words[fi + 1]) for (const f of this._families(fw + q.words[fi + 1], 15)) fams.add(f);
    if (fw !== q.words[0] && q.words[0].length >= 3) for (const f of this._families(q.words[0], 15)) fams.add(f);
    const cache = new Map();
    const cands = [];
    for (const f of fams) {
      for (const r of this.famRows[f].slice(0, 300)) cands.push({ row: r, f: this.features(q, r, cache) });
    }
    return { q, cands };
  }

  _generic(q) {
    // Generic-name line, e.g. "PARACETAMOL 500MG TAB" or "AMOXYCILLIN 500 CAP"
    if (!q.words.length || !q.strengths.length) return null;
    const found = [];
    for (const w of q.words) {
      if (w.length < 4) continue;
      let best = null, bs = 0;
      for (const s of this.salts) {
        const first = s.split(" ")[0];
        const sim = similarity(w, first);
        if (sim > bs) { bs = sim; best = s; }
      }
      if (bs >= 0.84 && !found.some((x) => x.salt === best)) found.push({ salt: best, sim: bs });
    }
    if (!found.length || found.length !== q.strengths.length) return null;
    const pairs = found.map((x, i) => {
      const s = q.strengths[i];
      const mg = strengthMg(s)[0];
      return `${x.salt} ${+mg.toFixed(4)}${s.u === "iu" ? "iu" : "mg"}`;
    });
    const key = pairs.sort().join(" + ");
    if (!this.compIndex.has(key)) return null;
    const conf = Math.min(...found.map((x) => x.sim));
    return { kind: "generic", key, form: q.form || "tab", label: found.map((x) => x.salt).join(" + "), prob: 0.5 + 0.45 * conf, pack: q.pack || null };
  }

  /**
   * Best interpretations of a bill line name.
   * @returns {{best: object|null, alternatives: object[], query: object}}
   */
  match(name, opts = {}) {
    const { q, cands } = this.candidates(name, opts);
    const scored = cands.map((c) => ({ ...c, p: this.score(c.f) })).sort((a, b) => b.p - a.p);
    const seen = new Set();
    const alts = [];
    for (const c of scored) {
      const row = this.rows[c.row];
      const sig = `${row[0].toLowerCase()}|${row[2]}|${row[1]}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      alts.push({
        kind: "brand", row: c.row, label: row[0], form: this.forms[row[1]], key: this.comps[row[2]],
        pack: q.pack || row[3] || null, packMl: row[4] || null, prob: c.p, f: c.f,
      });
      if (alts.length >= 6) break;
    }
    const gen = this._generic(q);
    if (gen && (!alts.length || alts[0].prob < gen.prob)) alts.unshift(gen);
    // Same brand, different strength, and the bill text cannot tell them apart:
    // mark as ambiguous so price flags are only raised if every reading agrees.
    if (alts.length > 1 && alts[0].kind === "brand") {
      const top = alts[0];
      const rivals = alts.filter((a) => a !== top && a.kind === "brand" && a.key !== top.key && a.form.replace("_mr", "") === top.form.replace("_mr", "") && top.prob - a.prob < 0.15 && a.f.labelNumsFound >= top.f.labelNumsFound && a.f.queryNumsExplained >= top.f.queryNumsExplained && a.f.extraLabelWords <= top.f.extraLabelWords && familyWord(analyseName(a.label).words) === familyWord(analyseName(top.label).words));
      if (rivals.length) top.ambiguous = rivals;
    }
    // If the bill states MR/SR, prefer the row form; otherwise keep the brand's own form.
    return { best: alts[0] || null, alternatives: alts.slice(0, 5), query: q };
  }
}
