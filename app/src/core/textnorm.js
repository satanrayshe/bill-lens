// Text helpers shared by the parser and the matcher.

export const FORM_WORDS = new Set([
  "tab", "tabs", "tablet", "tablets", "tb", "cap", "caps", "capsule", "capsules", "syp", "syrup", "susp", "suspension",
  "inj", "injection", "oint", "ointment", "cream", "gel", "drops", "drop", "lotion", "sachet", "soln", "solution", "liq",
]);
const FORM_CLASS = {
  tab: "tab", tabs: "tab", tablet: "tab", tablets: "tab", tb: "tab",
  cap: "cap", caps: "cap", capsule: "cap", capsules: "cap",
  syp: "liquid", syrup: "liquid", susp: "liquid", suspension: "liquid", liq: "liquid", soln: "liquid", solution: "liquid",
  inj: "inj", injection: "inj",
  oint: "topical", ointment: "topical", cream: "topical", gel: "topical", lotion: "topical",
  drops: "drops", drop: "drops", sachet: "powder",
};
const MR_WORDS = new Set(["sr", "er", "xr", "cr", "mr", "pr", "xl"]);

/** Fix letters that OCR put inside numbers: "65O" -> "650", "l0" -> "10", "2l.5O" -> "21.50". */
export function fixNumericToken(t) {
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (digits === 0 || letters > digits) return t;
  return t.replace(/[Oo]/g, "0").replace(/[lI|]/g, "1").replace(/[Ss]/g, "5").replace(/B/g, "8").replace(/Z/g, "2");
}

/** Fix digits that OCR put inside words: "D0LO" -> "DOLO", "AMLONG" etc. Keeps strength-like tokens. */
export function fixAlphaToken(t) {
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (letters === 0 || digits === 0) return t;
  if (/^\d+(\.\d+)?(mg|mcg|g|ml|iu|gm|%)/i.test(t)) return t; // 500MG, 10MG/10MG
  if (/^\d/.test(t) && digits >= letters) return t;
  if (letters >= 2 * digits) return t.replace(/0/g, "O").replace(/1/g, "I").replace(/5/g, "S").replace(/8/g, "B");
  return t;
}

/** Normalise a medicine name for matching: lowercase, unify separators, split strength units. */
export function normName(s) {
  return s
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/(\d)\s*(mg|mcg|gm|g|ml|iu)\b/g, "$1$2")
    .replace(/[^a-z0-9.%/+ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a bill name into brand words, numbers, form hints and pack size. */
export function analyseName(raw) {
  const n = normName(raw);
  const toks = n
    .split(" ")
    .filter(Boolean)
    // "SMG" / "S00MG" / "LOMG": OCR read digits as letters inside a strength
    .map((t) => {
      const m = t.match(/^([soilbz0-9.]+)(mg|mcg|ml|gm)$/);
      return m && /[soilbz]/.test(m[1]) ? m[1].replace(/s/g, "5").replace(/o/g, "0").replace(/[il]/g, "1").replace(/b/g, "8").replace(/z/g, "2") + m[2] : t;
    });
  const out = { norm: n, words: [], nums: [], altNums: [], form: null, mr: false, pack: null, strengths: [] };
  for (const t of toks) {
    let m;
    if ((m = t.match(/^(\d+)s$/)) || (m = t.match(/^1x(\d+)$/)) || (m = t.match(/^(\d+)s5$/))) {
      out.pack = +m[1];
      continue;
    }
    if (FORM_CLASS[t]) {
      out.form = out.form || FORM_CLASS[t];
      continue;
    }
    if (MR_WORDS.has(t)) {
      out.mr = true;
      out.words.push(t);
      continue;
    }
    if ((m = t.match(/^(\d+(?:\.\d+)?)(mg|mcg|g|gm|ml|iu|%)?((?:\/\d+(?:\.\d+)?(?:mg|mcg|g|ml)?)*)$/))) {
      out.nums.push(+m[1]);
      for (const part of t.split("/")) {
        const mm = part.match(/^(\d+(?:\.\d+)?)(mg|mcg|g|gm|iu)?$/);
        if (mm) out.strengths.push({ v: +mm[1], u: mm[2] || null });
      }
      continue;
    }
    // "STAMLO S" - a lone S/O/I/L/B/Z is often an OCR-mangled digit
    if (t.length <= 3 && out.words.length && /^[soilbz]+$/.test(t)) {
      const alt = +fixNumericToken(t.toUpperCase());
      if (!Number.isNaN(alt)) out.altNums.push(alt);
    }
    out.words.push(t);
  }
  if (out.mr && out.form === "tab") out.form = "tab_mr";
  if (out.mr && out.form === "cap") out.form = "cap_mr";
  return out;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : confusable(a[i - 1], b[j - 1]) ? 0.4 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const CONFUSE = ["o0", "il", "i1", "l1", "s5", "b8", "z2", "ec", "rn", "un", "uv", "vy", "hb", "gq", "cg", "ft", "kx"];
const CONF_SET = new Set(CONFUSE.flatMap((p) => [p, p[1] + p[0]]));
function confusable(x, y) {
  return CONF_SET.has(x + y);
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export function trigrams(s) {
  const t = `  ${s} `;
  const out = [];
  for (let i = 0; i < t.length - 2; i++) out.push(t.slice(i, i + 3));
  return out;
}

export function dice(a, b) {
  const A = trigrams(a), B = new Map();
  for (const g of trigrams(b)) B.set(g, (B.get(g) || 0) + 1);
  let inter = 0;
  for (const g of A) {
    const c = B.get(g);
    if (c) { inter++; B.set(g, c - 1); }
  }
  return (2 * inter) / (A.length + trigrams(b).length);
}
