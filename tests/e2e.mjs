// End-to-end check of the production build in headless Chromium.
//   npm run build && npx vite preview app --port 4173   (in another terminal)
//   node tests/e2e.mjs [outDir]
// Checks: sample bills give the expected findings, photo upload works,
// English/Hindi toggle, offline reload (service worker), desktop + mobile.
import { chromium, devices } from "playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const URL = process.env.BL_URL || "http://localhost:4173/bill-lens/";
const OUT = process.argv[2] || "tests/out";
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, info = "") => {
  results.push({ name, pass: !!cond, info });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  " + info : ""}`);
};

async function waitReady(page) {
  await page.waitForFunction(() => document.querySelector("[data-engine]")?.textContent.match(/Ready|तैयार/), null, { timeout: 180000 });
}
async function runSample(page, id) {
  await page.click(`[data-act=sample][data-id=${id}]`);
  await page.waitForSelector(".summary", { timeout: 180000 });
  return page.evaluate(() => ({
    paid: document.querySelector(".paid-big .big")?.textContent,
    over: document.querySelector(".fig.bad .big")?.textContent || null,
    save: document.querySelector(".fig.save .big")?.textContent || null,
    flagged: document.querySelectorAll(".line.flagged").length,
    lines: [...document.querySelectorAll(".line")].map((l) => l.querySelector(".ident strong")?.textContent),
  }));
}

const browser = await chromium.launch();
try {
  // ---------- desktop ----------
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL);
  await waitReady(page);
  ok("engine ready (data + OCR loaded)", true);
  await page.screenshot({ path: path.join(OUT, "desktop-home.png") });

  let r = await runSample(page, "overcharge");
  ok("overcharge sample: 5 lines", r.lines.length === 5, JSON.stringify(r.lines));
  ok("overcharge sample: 2 flagged lines (Augmentin 625 Duo, Dolo 650)", r.flagged === 2, `flagged=${r.flagged}`);
  ok("overcharge sample: total ₹942.94", r.paid === "₹942.94", r.paid);
  await page.screenshot({ path: path.join(OUT, "desktop-overcharge.png"), fullPage: false });
  await page.click(".line.flagged [data-act=calc]");
  await page.waitForSelector(".calc");
  const calc = await page.textContent(".calc");
  ok("calculation shows S.O. number and GST rule", /S\.O\. 1575\(E\)/.test(calc) && /GST/.test(calc), calc.slice(0, 160));
  await page.locator(".line.flagged").first().screenshot({ path: path.join(OUT, "desktop-line-calc.png") });

  await page.click("[data-act=home]");
  r = await runSample(page, "clean");
  ok("clean sample: no flags", r.flagged === 0 && r.over === null, JSON.stringify(r));
  ok("clean sample: generic savings shown", !!r.save, r.save);

  await page.click("[data-act=home]");
  r = await runSample(page, "hospital");
  ok("hospital sample: 1 flagged line (Ondem 4)", r.flagged === 1, JSON.stringify(r.lines));

  // language toggle
  await page.click("[data-act=lang]");
  const hiText = await page.textContent(".summary");
  ok("Hindi toggle changes interface text", /आपने चुकाए/.test(hiText));
  await page.screenshot({ path: path.join(OUT, "desktop-hindi.png") });
  await page.click("[data-act=lang]");

  // photo upload (a held-out style bill photo not used by the app)
  await page.click("[data-act=home]");
  const upload = process.env.BL_UPLOAD || "eval/bills/dev/dev-001.jpg";
  await page.setInputFiles("#file", upload);
  await page.waitForSelector(".summary", { timeout: 180000 });
  const nUp = await page.locator(".line").count();
  ok("photo upload reads lines", nUp >= 3, `${nUp} lines from ${upload}`);

  // edit a line: change quantity and check the total updates
  await page.click("[data-act=edit][data-i='0']");
  await page.fill("#line-0 input[name=amount]", "9999");
  await page.click("#line-0 [data-act=apply]");
  await page.waitForTimeout(500);
  const paidAfter = await page.textContent(".paid-big .big");
  ok("inline edit updates the summary", /9,9|10,|11,|12,/.test(paidAfter), paidAfter);

  // offline reload
  await page.goto(URL);
  await waitReady(page);
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
  await page.reload();
  await waitReady(page);
  await ctx.setOffline(true);
  await page.reload();
  await waitReady(page);
  r = await runSample(page, "overcharge");
  ok("offline reload: app loads and checks a sample with no network", r.flagged === 2, JSON.stringify(r));
  await ctx.setOffline(false);
  ok("no uncaught page errors (desktop)", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // ---------- mobile ----------
  const m = await browser.newContext({ ...devices["Pixel 7"] });
  const mp = await m.newPage();
  const merr = [];
  mp.on("pageerror", (e) => merr.push(String(e)));
  await mp.goto(URL);
  await waitReady(mp);
  await mp.screenshot({ path: path.join(OUT, "mobile-home.png") });
  r = await runSample(mp, "overcharge");
  ok("mobile: overcharge sample flags 2 lines", r.flagged === 2);
  await mp.screenshot({ path: path.join(OUT, "mobile-summary.png") });
  await mp.locator(".line.flagged").first().scrollIntoViewIfNeeded();
  await mp.screenshot({ path: path.join(OUT, "mobile-line.png") });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok("mobile: no horizontal overflow", !overflow);
  await mp.click("[data-act=lang]");
  await mp.evaluate(() => window.scrollTo(0, 0));
  await mp.screenshot({ path: path.join(OUT, "mobile-hindi.png") });
  ok("no uncaught page errors (mobile)", merr.length === 0, merr.join(" | "));
  await m.close();
} finally {
  await browser.close();
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
