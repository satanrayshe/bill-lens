// OCR lines -> parsed items -> matched medicines -> price checks -> summary.
import { parseBill } from "./parse.js";
import { Matcher } from "./matcher.js";
import { checkLine, indexByKeyForm, summarise } from "./check.js";

export class Engine {
  /** @param data {brands, nppa, pmbjp, weights} */
  constructor(data) {
    this.matcher = new Matcher(data.brands, data.weights);
    this.idx = { nppa: indexByKeyForm(data.nppa), pmbjp: indexByKeyForm(data.pmbjp) };
    this.nppa = data.nppa;
    this.pmbjp = data.pmbjp;
  }

  analyseLines(lines) {
    const parsed = parseBill(lines);
    const out = parsed.items.map((item) => this.analyseItem(item, parsed.rateBasisHint));
    return { lines: out, parsed, summary: summarise(out, parsed.total) };
  }

  analyseItem(item, hint, forcedMatch) {
    const m = forcedMatch ? { best: forcedMatch, alternatives: [forcedMatch] } : this.matcher.match(item.name, { pack: item.pack });
    let best = m.best && (m.best.prob >= 0.2 || m.best.kind === "generic") ? m.best : null;
    if (best && best.kind === "brand" && !item.pack && !forcedMatch) best = this.choosePack(item, best, hint);
    const check = checkLine(item, best, this.idx, hint);
    if (best && best.ambiguous && check.flags.length) {
      // keep a flag only if it holds for every equally likely reading
      const keep = check.flags.filter((f) => best.ambiguous.every((alt) => checkLine(item, alt, this.idx, hint).flags.includes(f)));
      if (keep.length !== check.flags.length) {
        check.flags = keep;
        if (!keep.includes("over_ceiling") && check.ceiling) delete check.ceiling.excess;
        if (!keep.includes("over_mrp") && check.mrpCheck) delete check.mrpCheck.excess;
        check.overcharge = Math.max(check.ceiling?.excess || 0, check.mrpCheck?.excess || 0);
        check.status = keep.length ? "flag" : "ok";
      }
      check.confidence = "low";
      check.ambiguousStrength = true;
    }
    return { item, match: best, alternatives: m.alternatives, check };
  }

  // The same brand is often sold in strips of 10, 15 or 30. When the bill does not
  // print the pack size, use the printed MRP (never the charged rate, which could
  // hide an overcharge) to pick the most plausible pack; otherwise keep the most
  // common pack and mark it as a guess.
  choosePack(item, best, hint) {
    const packs = this.matcher.packsFor(best.row);
    if (packs.length < 2) return best;
    if (!item.mrp) return { ...best, packGuessed: true, packOptions: packs };
    const c0 = checkLine({ ...item, mrp: null, amount: null, rate: null }, best, this.idx, hint);
    const ref = c0.ceiling ? c0.ceiling.limit * 0.8 : null;
    if (!ref) return { ...best, packGuessed: true, packOptions: packs };
    let pick = best.pack, bestD = Infinity;
    for (const p of packs) {
      const d = Math.abs(Math.log(item.mrp / p / ref));
      if (d < bestD) { bestD = d; pick = p; }
    }
    return { ...best, pack: pick, packGuessed: true, packOptions: packs };
  }

  recheck(lines, billTotal) {
    return summarise(lines, billTotal);
  }
}
