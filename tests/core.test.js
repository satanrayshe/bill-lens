import test from "node:test";
import assert from "node:assert/strict";
import { numericValues, parseBill } from "../app/src/core/parse.js";
import { checkLine, indexByKeyForm, inferBasis } from "../app/src/core/check.js";
import { analyseName } from "../app/src/core/textnorm.js";

test("dropped decimal point gives a repaired alternative", () => {
  assert.deepEqual(numericValues("21254"), [21254, 212.54]);
  assert.deepEqual(numericValues("2.72"), [2.72]);
  assert.deepEqual(numericValues("6S0"), [650, 6.5]);
});

test("OCR letters inside strengths are read as digits", () => {
  const a = analyseName("ADP SMG TAB");
  assert.equal(a.strengths[0].v, 5);
  assert.equal(a.form, "tab");
});

const W = (text, x0, x1, y = 100) => ({ text, x0, x1, y0: y, y1: y + 20, conf: 90 });
const line = (words, y) => ({ text: words.map((w) => w.text).join(" "), conf: 90, x0: words[0].x0, x1: words.at(-1).x1, y0: y, y1: y + 20, words: words.map((w) => ({ ...w, y0: y, y1: y + 20 })) });

test("header columns + arithmetic pick qty, rate and amount", () => {
  const lines = [
    line([W("Product", 50, 120), W("Qty", 400, 430), W("MRP", 480, 520), W("Rate", 560, 600), W("Amount", 650, 720)], 50),
    line([W("DOLO", 50, 100), W("650", 105, 140), W("TAB", 145, 180), W("2", 410, 420), W("2906", 480, 520), W("36.50", 560, 600), W("73.00", 660, 720)], 90),
    line([W("Grand", 400, 450), W("Total", 455, 500), W("73.00", 660, 720)], 130),
  ];
  const p = parseBill(lines);
  assert.equal(p.items.length, 1);
  const it = p.items[0];
  assert.equal(it.name, "DOLO 650 TAB");
  assert.equal(it.qty, 2);
  assert.equal(it.rate, 36.5);
  assert.equal(it.amount, 73);
  assert.equal(it.mrp, 29.06);
  assert.equal(p.total, 73);
});

test("ceiling rule: limit is ceiling x (1 + GST), per unit", () => {
  const nppa = [{ id: "22-569", list: "NLEM 2022", sl: 569, so: "S.O. 1575(E)", medicine: "Paracetamol", dosage: "Tablet 650mg", unitText: "1 Tablet", unit: { kind: "unit" }, form: "tab", key: "paracetamol 650mg", ceiling: 2.05 }];
  const idx = { nppa: indexByKeyForm(nppa), pmbjp: indexByKeyForm([]) };
  const match = { key: "paracetamol 650mg", form: "tab", pack: 15, prob: 0.99, kind: "brand", label: "Dolo 650" };
  // 15 tablets for 32.20 = 2.147 / tab, limit 2.1525 -> within
  let c = checkLine({ name: "DOLO 650", qty: 1, rate: 32.2, amount: 32.2, mrp: 32.2, consistent: true }, match, idx);
  assert.deepEqual(c.flags, []);
  // 15 tablets for 36.50 = 2.433 / tab -> above limit and above MRP 29.06
  c = checkLine({ name: "DOLO 650", qty: 1, rate: 36.5, amount: 36.5, mrp: 29.06, consistent: true }, match, idx);
  assert.deepEqual(c.flags.sort(), ["over_ceiling", "over_mrp"]);
  assert.ok(Math.abs(c.ceiling.limit - 2.1525) < 1e-9);
  // bill prints GST 12% -> uses it
  c = checkLine({ name: "DOLO 650", qty: 1, rate: 34.0, amount: 34.0, gst: 12, consistent: true }, match, idx);
  assert.equal(c.gstRate, 0.12);
  assert.deepEqual(c.flags, []);
});

test("rate basis: compared with printed MRP", () => {
  assert.equal(inferBasis({ qty: 2, rate: 29.06, mrp: 29.06 }, 15, {}, null).basis, "pack");
  assert.equal(inferBasis({ qty: 30, rate: 1.94, mrp: 29.06 }, 15, {}, null).basis, "unit");
});
