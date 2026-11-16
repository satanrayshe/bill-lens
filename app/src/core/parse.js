// Turn OCR lines into bill line items.
//
// Layout varies a lot between pharmacy billing programs, so the parser does not
// trust any single cue. It combines:
//   1. the column header (Qty / MRP / Rate / Amount ...) when one is found,
//   2. token shapes (batch numbers, expiry dates, pack sizes like 1x15 or 15'S),
//   3. arithmetic: on a real line, qty x rate (less discount) equals the amount.
// The arithmetic check also repairs the most common OCR error on bills, a
// dropped decimal point ("21254" for "212.54").

import { fixNumericToken, fixAlphaToken, FORM_WORDS } from "./textnorm.js";

const HEADER_KEYS = {
  qty: /^(qty|qnty|qty\.|quantity|qt[yv])$/i,
  mrp: /^m\.?r\.?p\.?$/i,
  rate: /^(rate|price|unitprice|u\.?price|unit|s\.?rate)$/i,
  amount: /^(amount|amt|amt\.|total|value|net)$/i,
  pack: /^(pack|pkg|pk|packing)$/i,
  disc: /^(disc%?|disc\.|discount|dis%?)$/i,
  gst: /^(gst%?|gst|tax%?|cgst|vat)$/i,
  batch: /^(batch|b\.?no\.?|batch\.?no)$/i,
  exp: /^(exp\.?|expiry|exp\.?dt)$/i,
  name: /^(product|description|item|particulars|medicine|items|product\/s)$/i,
};
const FOOTER = /\b(total|net|grand|payable|taxable|cgst|sgst|igst|round|rupees|in words|subtotal|sub-total|discount amt|amount payable)\b/i;
const NOT_ITEM = /\b(gstin|d\.?l\.?|lic|bill no|inv no|invoice|patient|name:|dr\.|doctor|date|uhid|phone|ph:|mob|address|cash memo|tax invoice|statement|prescribed)\b/i;

function tokenise(line) {
  return line.words
    .map((w) => ({ ...w, t: w.text.replace(/^[|:;!{}\[\]()~_—–-]+|[|:;!{}\[\]~_—–]+$/g, "") }))
    .filter((w) => w.t.length > 0 && !/^[^A-Za-z0-9]+$/.test(w.t));
}

function headerColumns(line) {
  const cols = {};
  let hits = 0;
  const toks = tokenise(line);
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    let t = w.t.replace(/[.:]+$/, "");
    // "Unit Price" -> rate, "Product Name" -> name
    if (/^unit$/i.test(t) && toks[i + 1] && /^price$/i.test(toks[i + 1].t)) t = "unitprice";
    for (const [k, re] of Object.entries(HEADER_KEYS)) {
      if (re.test(t) && !(k in cols)) {
        const x1 = t === "unitprice" ? toks[i + 1].x1 : w.x1;
        cols[k] = { x0: w.x0, x1, xc: (w.x0 + x1) / 2 };
        hits++;
        break;
      }
    }
  }
  return hits >= 3 && (cols.amount || cols.rate || cols.mrp) ? cols : null;
}

const RE_BATCH = /^(b[:.]|batch)/i;
const RE_EXP = /^(e[:.])?\d{1,2}[\/-]\d{2,4}$|^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$|^(exp|e)[:.]/i;
const RE_PACK = /^(\d{1,2})\s*[x×*]\s*(\d{1,3})$|^(\d{1,3})(?:['’`][sS5]|[sS])$/;
const RE_STRENGTH = /^\d+(\.\d+)?(mg|mcg|gm|g|ml|iu|%)(\/\d+(\.\d+)?(mg|mcg|gm|g|ml)?)*$/i;

function isBatchLike(t) {
  if (RE_BATCH.test(t)) return true;
  // e.g. WJ63883, TF74467: letters then >=3 digits, mixed, length >= 5
  return /^[A-Za-z]{1,4}\d{3,}[A-Za-z0-9]*$/.test(t) && t.length >= 5;
}

/** Candidate numeric values for a token, including a repaired decimal point. */
export function numericValues(raw) {
  let t = fixNumericToken(raw).replace(/^rs\.?/i, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) {
    const m = t.match(/^(\d+)[.,](\d{1,2})\D*$/);
    if (m) t = `${m[1]}.${m[2]}`;
    else return null;
  }
  const v = parseFloat(t);
  const vals = [v];
  if (!t.includes(".") && t.length >= 3) vals.push(v / 100); // dropped decimal point
  return vals;
}

function lineKind(toks) {
  let alpha = 0, nums = 0;
  for (const w of toks) {
    if (numericValues(w.t)) nums++;
    else if (/[A-Za-z]{3,}/.test(w.t) && !isBatchLike(w.t) && !RE_EXP.test(w.t)) alpha++;
  }
  return { alpha, nums };
}

function nearestCol(cols, xc, keys) {
  let best = null, bd = Infinity;
  for (const k of keys) {
    if (!cols[k]) continue;
    const c = cols[k];
    const d = xc < c.x0 ? c.x0 - xc : xc > c.x1 ? xc - c.x1 : 0;
    if (d < bd) { bd = d; best = k; }
  }
  return { key: best, dist: bd };
}

/**
 * Choose qty / rate / amount (and MRP, discount, GST) from numeric tokens.
 * Returns the most consistent assignment with a score.
 */
function assignNumbers(nums, cols, colWidth) {
  const n = nums.length;
  const best = { score: -Infinity };
  if (n < 2) return null;
  const colOf = nums.map((t) => (cols ? nearestCol(cols, t.xc, ["qty", "mrp", "rate", "amount", "disc", "gst", "pack"]) : { key: null, dist: Infinity }));
  // candidate amount: any token; prefer rightmost
  for (let ai = n - 1; ai >= 0; ai--) {
    for (const a of nums[ai].vals) {
      for (let qi = 0; qi < n; qi++) {
        if (qi === ai) continue;
        for (const q of nums[qi].vals) {
          if (!(q > 0 && q <= 1000 && Math.abs(q - Math.round(q)) < 1e-9)) continue;
          for (let ri = 0; ri < n; ri++) {
            if (ri === ai || ri === qi) continue;
            for (const r of nums[ri].vals) {
              if (!(r > 0)) continue;
              // optional discount column
              const discTok = cols && cols.disc ? nums.find((t, i) => i !== ai && i !== qi && i !== ri && colOf[i].key === "disc") : null;
              const d = discTok ? discTok.vals[0] : 0;
              const expected = q * r * (1 - (d >= 0 && d < 60 ? d : 0) / 100);
              const err = Math.abs(expected - a) / Math.max(1, a);
              if (err > 0.012) continue;
              let score = 10 - err * 200;
              if (ai === n - 1) score += 2; // amount is usually the last number
              if (qi < ri && ri < ai) score += 1.5; // left-to-right qty, rate, amount
              if (nums[ai].vals[0] !== a) score -= 1.5; // needed decimal repair
              if (nums[ri].vals[0] !== r) score -= 1.5;
              if (nums[qi].vals[0] !== q) score -= 3;
              if (cols) {
                const near = (i, key) => colOf[i].key === key && colOf[i].dist < colWidth;
                if (near(ai, "amount")) score += 2;
                if (near(qi, "qty")) score += 2;
                if (near(ri, "rate")) score += 2;
                else if (near(ri, "mrp")) score += 1;
              }
              if (q > 1 && r === a) score -= 1;
              if (score > best.score) {
                best.score = score;
                best.q = q; best.r = r; best.a = a; best.d = d; best.idx = [qi, ri, ai];
              }
            }
          }
        }
      }
    }
  }
  if (best.score === -Infinity) return null;
  // MRP: a remaining token in an MRP column, or a value close to the rate.
  let mrp = null, gst = null;
  nums.forEach((t, i) => {
    if (best.idx.includes(i)) return;
    const c = colOf[i];
    if (cols && c.key === "gst" && c.dist < colWidth && t.vals[0] <= 28) gst = t.vals[0];
    else if (cols && c.key === "mrp" && c.dist < colWidth) {
      mrp = t.vals.find((v) => v >= best.r * 0.4 && v <= best.r * 3) ?? t.vals[0];
    }
  });
  if (cols && cols.mrp && mrp === null) {
    // MRP column exists but OCR merged/misplaced it: take a leftover value near the rate
    nums.forEach((t, i) => {
      if (best.idx.includes(i) || mrp !== null) return;
      const v = t.vals.find((x) => x >= best.r * 0.5 && x <= best.r * 2.5);
      if (v !== undefined) mrp = v;
    });
  }
  // If the header says the "rate" token is really in the MRP column and there is no separate rate column, treat it as MRP too
  if (cols && cols.mrp && !cols.rate && mrp === null) mrp = best.r;
  return { qty: best.q, rate: best.r, amount: best.a, disc: best.d || 0, mrp, gst, score: best.score };
}

function splitNameAndNumbers(toks, cols) {
  // Name: leading alphabetic run (plus strengths/numbers glued to it) up to the
  // first batch / expiry / pack / numeric-column token.
  let nameEnd = -1;
  const nameX = cols && cols.name ? cols.name.x0 : -Infinity;
  const rightCols = cols ? ["pack", "batch", "exp", "qty", "mrp", "rate", "amount"].filter((k) => cols[k] && cols[k].x0 > nameX) : [];
  const nameLimit = rightCols.length ? Math.min(...rightCols.map((k) => cols[k].x0)) - 4 : Infinity;
  const nameStartLimit = cols && cols.name ? cols.name.x0 - 30 : -Infinity;
  let started = false;
  const nameToks = [], rest = [];
  let pack = null;
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    const t = w.t;
    const pm = t.match(RE_PACK);
    if (pm && (started || !cols)) {
      pack = +(pm[2] || pm[3]);
      if (started && /['’`]?[sS5]$/.test(t) && !cols?.pack) { /* 15'S inside name column */ }
      continue;
    }
    if (!started) {
      const alphaLike = /[A-Za-z]{2,}/.test(t) && !isBatchLike(t) && !RE_EXP.test(t);
      if (alphaLike && w.x0 >= nameStartLimit && !/^(b|e)[:.]/i.test(t)) {
        started = true;
        nameToks.push(w);
      } else rest.push(w);
      continue;
    }
    const inNameCol = w.x1 <= nameLimit + 6;
    const looksName = /[A-Za-z]/.test(t) && !isBatchLike(t) && !RE_EXP.test(t);
    const strengthy = RE_STRENGTH.test(t) || (/^\d+(\.\d+)?$/.test(t) && nameToks.length && !cols && i < toks.length - 3);
    if (nameEnd < 0 && ((cols && inNameCol && (looksName || /^\d/.test(t)) && !isBatchLike(t) && !RE_EXP.test(t)) || (!cols && (looksName || strengthy)))) {
      nameToks.push(w);
      if (FORM_WORDS.has(t.toLowerCase()) && !cols) nameEnd = i;
    } else {
      nameEnd = nameEnd < 0 ? i : nameEnd;
      rest.push(w);
    }
  }
  return { nameToks, rest, pack };
}

/**
 * @param {Array} lines OCR lines (see ocrlines.js)
 * @returns {{items: Array, columns: object|null, total: number|null}}
 */
export function parseBill(lines) {
  let cols = null, headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const c = headerColumns(lines[i]);
    if (c) { cols = c; headerIdx = i; break; }
  }
  const colXs = cols ? Object.values(cols).map((c) => c.xc).sort((a, b) => a - b) : [];
  let colWidth = 120;
  if (colXs.length > 1) {
    const gaps = colXs.slice(1).map((x, i) => x - colXs[i]).sort((a, b) => a - b);
    colWidth = Math.max(40, gaps[Math.floor(gaps.length / 2)] * 0.75);
  }

  // Collect candidate rows between header and footer, merging name-only lines
  // with a following numbers line (thermal receipts print them on two lines).
  const rows = [];
  let total = null;
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const ln = lines[i];
    const toks = tokenise(ln);
    if (!toks.length) continue;
    const text = toks.map((w) => w.t).join(" ");
    if (FOOTER.test(text)) {
      const nums = toks.map((w) => numericValues(w.t)).filter(Boolean).map((v) => v[0]);
      if (/\b(grand|net|payable|total)\b/i.test(text) && nums.length && total === null) total = nums[nums.length - 1];
      if (headerIdx >= 0 && rows.length) {
        if (/\b(grand|net amount|net payable|payable|total)\b/i.test(text)) break;
      }
      continue;
    }
    if (NOT_ITEM.test(text) && headerIdx < 0) continue;
    const k = lineKind(toks);
    const prev = rows[rows.length - 1];
    if (prev && prev.pendingName && k.alpha === 0 && k.nums >= 2) {
      prev.toks = [...prev.toks, ...toks];
      prev.pendingName = false;
      prev.lines.push(i);
      continue;
    }
    if (k.alpha >= 1 && k.nums < 2) {
      rows.push({ toks, lines: [i], pendingName: true });
      continue;
    }
    if (k.alpha >= 1 && k.nums >= 2) rows.push({ toks, lines: [i], pendingName: false });
  }

  const items = [];
  for (const r of rows) {
    if (r.pendingName) continue;
    const { nameToks, rest, pack } = splitNameAndNumbers(r.toks, cols);
    if (!nameToks.length) continue;
    const nums = [];
    for (const w of rest) {
      if (isBatchLike(w.t) || RE_EXP.test(w.t)) continue;
      const vals = numericValues(w.t);
      if (vals) nums.push({ t: w.t, vals, xc: (w.x0 + w.x1) / 2 });
    }
    // Leading serial number / junk before the name is not a quantity on most layouts,
    // except when the header says Qty is the first column (cash memos).
    const firstNameX = nameToks[0].x0;
    const qtyFirst = cols && cols.qty && cols.qty.xc < (cols.name ? cols.name.x0 : firstNameX);
    const usable = nums.filter((t) => t.xc > firstNameX || qtyFirst);
    const asg = assignNumbers(usable, cols, colWidth) || (qtyFirst ? null : assignNumbers(nums, cols, colWidth));
    const name = nameToks.map((w) => fixAlphaToken(w.t)).join(" ").replace(/\s+/g, " ").trim();
    if (!asg) {
      items.push({ name, qty: null, rate: null, amount: null, mrp: null, pack, consistent: false, lines: r.lines });
      continue;
    }
    items.push({ name, qty: asg.qty, rate: asg.rate, amount: asg.amount, mrp: asg.mrp, disc: asg.disc, gst: asg.gst, pack, consistent: true, score: asg.score, lines: r.lines });
  }
  const rateBasisHint = cols && cols.rate ? lines[headerIdx].text.match(/unit\s*price|per\s*(tab|unit)/i) ? "unit" : null : null;
  return { items, columns: cols ? Object.keys(cols) : null, total, rateBasisHint };
}
