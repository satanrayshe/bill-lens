import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function loadData() {
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(root, "app/public/data", f), "utf8"));
  const wPath = path.join(root, "app/public/models/matcher.json");
  let weights = fs.existsSync(wPath) ? JSON.parse(fs.readFileSync(wPath, "utf8")).weights : undefined;
  // Ablation: rank candidates by fuzzy brand-word similarity only (no learned scorer)
  if (process.env.BL_MATCHER === "fuzzy") weights = { bias: -8, famSim: 10, wordDice: 0.01 };
  return { brands: rd("brands.json"), nppa: rd("nppa.json"), pmbjp: rd("pmbjp.json"), weights };
}
export { root };
