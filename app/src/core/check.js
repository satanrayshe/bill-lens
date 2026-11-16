// Price checks for one bill line.
//
// Ceiling rule (NPPA S.O. 1575(E), 25 Mar 2026, w.e.f. 1 Apr 2026, and S.O. 1581(E)):
// ceiling prices are per unit (1 tablet / 1 capsule / 1 ml ...) and EXCLUDE GST.
// Note (d): no one may sell above "ceiling price (plus Goods and Services Taxes
// as applicable)". So the limit we compare with is ceiling x (1 + GST rate).
// GST on most medicines is 5% since 22 Sep 2025 (some are exempt). We use the
// GST % printed on the bill line when there is one, otherwise 5%, and say so.

export const DEFAULT_GST = 0.05;
const TOL_ABS = 0.01; // one paisa per unit for rounding
const TOL_REL = 0.005; // 0.5% for rounding of strip prices

export function indexByKeyForm(list) {
  const m = new Map();
  for (const e of list) {
    const k = `${e.key}|${e.form}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return m;
}

function ceilingFor(nppaIdx, key, form, packMl) {
  const list = nppaIdx.get(`${key}|${form}`) || [];
  const isLiquid = form === "liquid";
  const usable = list.filter((e) => (isLiquid ? e.unit.kind === "ml" && packMl : e.unit.kind === "unit"));
  usable.sort((a, b) => (a.list === "NLEM 2022" ? 0 : 1) - (b.list === "NLEM 2022" ? 0 : 1) || a.ceiling - b.ceiling);
  return usable[0] || null;
}

function genericFor(pmIdx, key, form, packMl) {
  const list = pmIdx.get(`${key}|${form}`) || [];
  const out = [];
  for (const e of list) {
    if (form === "liquid") {
      if (e.pack.ml) out.push({ ...e, perUnit: e.mrp / e.pack.ml, unitName: "ml" });
    } else if (e.pack.count) out.push({ ...e, perUnit: e.mrp / e.pack.count, unitName: "unit" });
  }
  out.sort((a, b) => a.perUnit - b.perUnit);
  return out[0] || null;
}

const logDist = (a, b) => Math.abs(Math.log(Math.max(a, 1e-6) / Math.max(b, 1e-6)));

/** Decide whether qty/rate are per pack (strip) or per unit (tablet). */
export function inferBasis(item, pack, refs, hint) {
  if (item.basis) return { basis: item.basis, why: "set by you" };
  if (!pack || pack <= 1) return { basis: "unit", why: "no pack size" };
  const rate = item.rate ?? (item.amount && item.qty ? item.amount / item.qty : null);
  if (rate == null) return { basis: "pack", why: "default" };
  const byRef = (ref, why) => {
    const dPack = logDist(rate / pack, ref), dUnit = logDist(rate, ref);
    return { basis: dPack < dUnit ? "pack" : "unit", why };
  };
  if (item.mrp) {
    const dPack = logDist(rate, item.mrp), dUnit = logDist(rate, item.mrp / pack);
    return { basis: dPack <= dUnit ? "pack" : "unit", why: "compared with printed MRP" };
  }
  if (hint === "unit") return { basis: "unit", why: "column says unit price" };
  if (refs.ceiling) return byRef(refs.ceiling, "compared with the NPPA ceiling");
  if (item.qty && item.qty >= pack && item.qty % pack === 0) return { basis: "unit", why: "quantity is a multiple of the pack" };
  if (refs.generic) return byRef(refs.generic, "compared with the generic price");
  return { basis: "pack", why: "default" };
}

/**
 * @param item parsed line {name, qty, rate, amount, mrp, gst, pack}
 * @param match matcher result {key, form, pack, packMl, prob, kind, label}
 * @param idx {nppa: Map, pmbjp: Map}
 * @param hint optional rate-basis hint from the column header
 */
export function checkLine(item, match, idx, hint) {
  const res = { flags: [], overcharge: 0, savings: 0 };
  if (!match) return { ...res, status: "unmatched" };
  const form = match.form;
  const pack = item.pack || match.pack || null;
  const packMl = match.packMl || null;
  const ceil = ceilingFor(idx.nppa, match.key, form, packMl);
  const gen = genericFor(idx.pmbjp, match.key, form, packMl);
  const gstRate = item.gst != null && [0, 5, 12, 18].includes(item.gst) ? item.gst / 100 : DEFAULT_GST;
  const refs = { ceiling: ceil ? ceil.ceiling * (1 + gstRate) : null, generic: gen ? gen.perUnit * 3 : null };

  let units, perUnit, basisInfo;
  if (form === "liquid") {
    // liquids: qty is number of bottles; compare per ml
    basisInfo = { basis: "pack", why: "bottle" };
    units = (item.qty || 1) * (packMl || 0);
    perUnit = units ? (item.amount ?? (item.rate || 0) * (item.qty || 1)) / units : null;
  } else {
    basisInfo = inferBasis(item, pack, refs, hint);
    const q = item.qty || 1;
    units = basisInfo.basis === "pack" ? q * (pack || 1) : q;
    const paid = item.amount ?? (item.rate != null ? item.rate * q : null);
    perUnit = paid != null && units ? paid / units : null;
  }
  Object.assign(res, { pack, units, perUnit, basis: basisInfo.basis, basisWhy: basisInfo.why, gstRate, gstAssumed: !(item.gst != null && [0, 5, 12, 18].includes(item.gst)) });

  if (ceil && perUnit != null) {
    const limit = ceil.ceiling * (1 + gstRate);
    res.ceiling = { id: ceil.id, list: ceil.list, sl: ceil.sl, so: ceil.so, medicine: ceil.medicine, dosage: ceil.dosage, unitText: ceil.unitText, ceiling: ceil.ceiling, limit };
    if (perUnit > limit * (1 + TOL_REL) + TOL_ABS) {
      res.flags.push("over_ceiling");
      res.ceiling.excess = (perUnit - limit) * units;
    }
  }
  if (item.mrp && pack && perUnit != null && form !== "liquid") {
    const perPack = perUnit * pack;
    res.mrpCheck = { mrp: item.mrp, perPack };
    if (perPack > item.mrp * (1 + TOL_REL) + TOL_ABS) {
      res.flags.push("over_mrp");
      res.mrpCheck.excess = (perPack - item.mrp) / pack * units;
    }
  }
  res.overcharge = Math.max(res.ceiling?.excess || 0, res.mrpCheck?.excess || 0);
  if (gen && perUnit != null) {
    const save = (perUnit - gen.perUnit) * units;
    res.generic = { code: gen.code, name: gen.name, unitSize: gen.unitSize, mrp: gen.mrp, perUnit: gen.perUnit, unitName: gen.unitName };
    if (save > 0.5) {
      res.savings = save;
      res.generic.savePct = (save / (perUnit * units)) * 100;
    }
  }
  // confidence label
  const p = match.prob ?? 0;
  let conf = p >= 0.8 ? "high" : p >= 0.5 ? "medium" : "low";
  if (!item.consistent && conf === "high") conf = "medium";
  if (basisInfo.why === "default" && conf === "high") conf = "medium";
  if (match.packGuessed && basisInfo.basis === "pack" && !item.mrp && conf === "high") conf = "medium";
  res.confidence = conf;
  res.status = res.flags.length ? "flag" : "ok";
  return res;
}

export function summarise(lines, billTotal) {
  const sumAmt = lines.reduce((s, l) => s + (l.item.amount || 0), 0);
  let total = sumAmt;
  let totalNote = "sum of lines";
  if (billTotal != null) {
    for (const t of [billTotal, billTotal / 100]) {
      if (Math.abs(t - sumAmt) <= Math.max(1, sumAmt * 0.01)) { total = t; totalNote = "matches bill total"; break; }
    }
    if (totalNote !== "matches bill total") totalNote = "bill total differs";
  }
  const over = lines.reduce((s, l) => s + (l.check?.overcharge || 0), 0);
  const save = lines.reduce((s, l) => s + (l.check?.savings || 0), 0);
  return { total, sumLines: sumAmt, billTotal, totalNote, overcharge: over, savings: save, flagged: lines.filter((l) => l.check?.flags?.length).length };
}
