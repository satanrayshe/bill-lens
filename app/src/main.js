import "./styles.css";
import { t, getLang, setLang } from "./i18n.js";
import { getOcrWorker, onOcrProgress, recognise } from "./ocr.js";
import { renderShareCard, shareText } from "./share.js";
import EngineWorker from "./engine.worker.js?worker";

const BASE = new URL(import.meta.env.BASE_URL, location.href).href;
const SAMPLES = [
  { id: "overcharge", file: "samples/sample-overcharge.jpg", en: "Neighbourhood chemist, GST invoice", hi: "मोहल्ले का केमिस्ट, GST बिल" },
  { id: "clean", file: "samples/sample-clean.jpg", en: "Thermal receipt, prices within limits", hi: "थर्मल रसीद, दाम सीमा के अंदर" },
  { id: "hospital", file: "samples/sample-hospital.jpg", en: "Hospital pharmacy statement", hi: "अस्पताल फ़ार्मेसी का बिल" },
];

// ---------- worker RPC ----------
const worker = new EngineWorker();
let rpcId = 0;
const pending = new Map();
const dataProgress = {};
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "progress") {
    dataProgress[m.label] = m;
    updateEngineStatus();
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.ok ? p.resolve(m.out) : p.reject(new Error(m.error));
};
function rpc(type, payload, transfer = []) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
}

// ---------- state ----------
const state = {
  view: "home",
  dataReady: false,
  ocrReady: false,
  ocrPct: 0,
  info: null,
  photoUrl: null,
  step: null,
  error: null,
  lines: [],
  billTotal: null,
  hint: null,
  summary: null,
  openCalc: new Set(),
  editing: null,
  sample: null,
};

const dataInit = rpc("init", { baseUrl: BASE }).then((info) => {
  state.dataReady = true;
  state.info = info;
  updateEngineStatus();
  return info;
});
dataInit.catch((e) => { state.error = String(e); render(); });

onOcrProgress((m) => {
  if (m.status && m.status.startsWith("loading") && typeof m.progress === "number") {
    state.ocrPct = Math.round(m.progress * 100);
    updateEngineStatus();
  }
  if (m.status === "recognizing text" && state.view === "working") {
    state.recogPct = Math.round(m.progress * 100);
    const el = document.querySelector("[data-recog]");
    if (el) el.textContent = `${state.recogPct}%`;
  }
});
// Warm the OCR engine so it is cached for offline use.
const ocrInit = getOcrWorker().then(() => { state.ocrReady = true; updateEngineStatus(); });
ocrInit.catch(() => {});

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (v, d = 2) => (v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const inr0 = (v) => inr(v, 0);

function unitWord(form) {
  if (!form) return t("unitUnit");
  if (form.startsWith("cap")) return t("unitCap");
  if (form.startsWith("tab")) return t("unitTab");
  if (form === "liquid") return t("unitMl");
  return t("unitUnit");
}

function prettyKey(key) {
  // "levothyroxine 0.05mg" -> "Levothyroxine 50 mcg"
  return key
    .split(" + ")
    .map((p) => {
      const m = p.match(/^(.*?)\s+(\d+(?:\.\d+)?)(mg|iu|%)(\/(ml|g))?$/);
      if (!m) return p;
      let [_, salt, v, u, per] = m;
      let val = +v;
      if (u === "mg" && val < 1 && !per) { val = +(val * 1000).toFixed(2); u = "mcg"; }
      const name = salt.replace(/\b\w/g, (c) => c.toUpperCase());
      return `${name} ${val} ${u}${per || ""}`;
    })
    .join(" + ");
}
const FORM_LABEL = { tab: "tablet", tab_mr: "extended-release tablet", cap: "capsule", cap_mr: "extended-release capsule", liquid: "oral liquid", inj: "injection", topical: "topical", eye_ear: "drops", inhal: "inhaler", supp: "suppository", drops: "drops", powder: "powder", other: "" };

// ---------- engine status ----------
function engineStatusHtml() {
  if (state.dataReady && state.ocrReady) return `<span class="dot ok"></span>${t("engine")}: ${t("engineReady")}`;
  const bytes = Object.values(dataProgress).reduce((s, p) => s + p.got, 0);
  const parts = [];
  if (!state.dataReady) parts.push(`${t("dataLoading")} ${bytes ? `(${(bytes / 1e6).toFixed(1)} MB)` : ""}`);
  if (!state.ocrReady) parts.push(`${t("engineLoading")} ${state.ocrPct ? state.ocrPct + "%" : ""}`);
  return `<span class="dot busy"></span>${parts.join(" · ")}`;
}
function updateEngineStatus() {
  const el = document.querySelector("[data-engine]");
  if (el) el.innerHTML = engineStatusHtml();
}

// ---------- views ----------
function header() {
  return `
  <header class="top">
    <button class="brand" data-act="home" aria-label="${esc(t("appName"))}">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><path d="M7 3h18v26l-3-2-3 2-3-2-3 2-3-2-3 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="16" cy="14" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.3 17.3l3.2 3.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <span>${esc(t("appName"))}</span>
    </button>
    <div class="top-r">
      <button class="link" data-act="about"><span class="long">${esc(t("sources"))}</span><span class="short">${esc(t("sourcesShort"))}</span></button>
      <button class="lang" data-act="lang" lang="${getLang() === "en" ? "hi" : "en"}">${esc(t("langToggle"))}</button>
    </div>
  </header>`;
}

function homeView() {
  return `
  <main class="home">
    <section class="hero">
      <h1>${esc(t("tagline"))}</h1>
      <label class="btn primary big" for="file">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
        ${esc(t("scanCta"))}
      </label>
      <input id="file" type="file" accept="image/*" hidden />
      <p class="hint">${esc(t("scanHint"))} ${esc(t("cameraNote"))}</p>
      <button class="btn ghost" data-act="manual">${esc(t("typeCta"))}</button>
      <p class="privacy">${esc(t("privacy"))}</p>
      <p class="engine" data-engine>${engineStatusHtml()}</p>
    </section>
    <section class="samples" aria-labelledby="samples-h">
      <h2 id="samples-h">${esc(t("samplesTitle"))}</h2>
      <div class="sample-row">
        ${SAMPLES.map((s) => `
          <button class="sample" data-act="sample" data-id="${s.id}">
            <img src="${BASE + s.file}" alt="" loading="lazy" width="320" height="240" />
            <span>${esc(s[getLang()])}</span>
          </button>`).join("")}
      </div>
      <p class="note">${esc(t("samplesNote"))}</p>
    </section>
  </main>`;
}

function workingView() {
  const steps = ["prepare", "read", "find", "check"];
  const cur = steps.indexOf(state.step);
  return `
  <main class="working">
    ${state.photoUrl ? `<div class="photo"><img src="${state.photoUrl}" alt="" /><div class="scanline"></div></div>` : ""}
    <ol class="steps" aria-live="polite">
      ${steps.map((s, i) => `<li class="${i < cur ? "done" : i === cur ? "now" : ""}">${esc(t("step_" + s))}${s === "read" && i === cur ? ` <span data-recog>${state.recogPct || 0}%</span>` : ""}</li>`).join("")}
    </ol>
  </main>`;
}

function confChip(c) {
  return `<span class="chip ${c}">${esc(t("conf_" + c))}</span>`;
}

function lineCard(l, i) {
  const { item, match, check } = l;
  const uw = unitWord(match?.form);
  const flagged = check.flags && check.flags.length;
  const open = state.openCalc.has(i);
  const editing = state.editing === i;
  let body = "";
  if (!match) {
    body = `<p class="muted">${esc(t("notIdentified"))}</p>`;
  } else {
    const ceil = check.ceiling;
    const gstPct = Math.round((check.gstRate ?? 0.05) * 100);
    body += `
      <div class="ident">
        <span class="lbl">${esc(t("identifiedAs"))}</span>
        <strong>${esc(match.kind === "brand" ? match.label : prettyKey(match.key))}</strong>
        <span class="salt">${esc(prettyKey(match.key))} · ${esc(FORM_LABEL[match.form] || match.form)}</span>
        ${confChip(check.confidence)}
      </div>
      <div class="paid">
        <div><span class="lbl">${esc(t("paidPer", uw))}</span><span class="num">₹${inr(check.perUnit)}</span></div>
        <div><span class="lbl">${esc(t("lineTotal"))}</span><span class="num">₹${inr(item.amount)}</span><span class="small">${check.units ? esc(t("qtyUnits", Math.round(check.units * 100) / 100, uw)) : ""}</span></div>
      </div>`;
    // ceiling
    if (ceil) {
      const above = check.flags.includes("over_ceiling");
      body += `
      <div class="check ${above ? "bad" : "good"}">
        <div class="ck-h"><span>${esc(t("ceilingTitle"))}</span><b>${esc(above ? t("ceilingAbove") : t("ceilingWithin"))}</b></div>
        <div class="ck-n">${esc(t("limitCalc", inr(ceil.ceiling), gstPct, inr(ceil.limit)))} / ${esc(uw)}</div>
        ${above ? `<div class="ck-x">${esc(t("excessLine", inr(ceil.excess)))}</div>` : ""}
      </div>`;
    } else {
      body += `<div class="check none"><div class="ck-h"><span>${esc(t("ceilingTitle"))}</span></div><div class="ck-n">${esc(t("ceilingNone"))}</div></div>`;
    }
    if (check.mrpCheck) {
      const above = check.flags.includes("over_mrp");
      body += `
      <div class="check ${above ? "bad" : "good"}">
        <div class="ck-h"><span>${esc(t("mrpTitle"))} ₹${inr(check.mrpCheck.mrp)}</span><b>${esc(above ? t("mrpAbove", inr(check.mrpCheck.excess)) : t("mrpOk"))}</b></div>
      </div>`;
    }
    const g = check.generic;
    if (g) {
      body += `
      <div class="generic ${check.savings ? "" : "flat"}">
        <div class="ck-h"><span>${esc(t("genericTitle"))}</span>${check.savings ? `<b>${esc(t("genericSave", inr0(check.savings), Math.round(g.savePct)))}</b>` : `<b class="muted">${esc(t("genericNoSave"))}</b>`}</div>
        <div class="ck-n">${esc(g.name)} · ₹${inr(g.mrp)} / ${esc(g.unitSize)} · ₹${inr(g.perUnit)} / ${esc(uw)} · code ${esc(g.code)}</div>
      </div>`;
    } else {
      body += `<div class="generic flat"><div class="ck-n">${esc(t("genericNone"))}</div></div>`;
    }
    body += `<button class="link calc-t" data-act="calc" data-i="${i}" aria-expanded="${open}">${esc(open ? t("hideCalc") : t("showCalc"))}</button>`;
    if (open) body += calcBlock(l);
  }
  return `
  <article class="line ${flagged ? "flagged" : ""}" id="line-${i}">
    <div class="line-h">
      <div><span class="lbl">${esc(t("asPrinted"))}</span><span class="printed">${esc(item.name)}</span></div>
      <button class="btn small" data-act="edit" data-i="${i}">${esc(editing ? t("done") : t("edit"))}</button>
    </div>
    ${editing ? editBlock(l, i) : ""}
    ${body}
  </article>`;
}

function calcBlock(l) {
  const { item, match, check } = l;
  const rows = [];
  const uw = unitWord(match.form);
  rows.push(`Qty ${item.qty ?? "–"} × rate ₹${inr(item.rate)}${item.disc ? ` − ${item.disc}%` : ""} = ₹${inr(item.amount)}`);
  rows.push(`${t("basisWhy")}: ${check.basis === "pack" ? t("perStrip") : t("perUnit")} (${check.basisWhy})${check.pack ? `, pack of ${check.pack}${match.packGuessed ? " (guessed)" : ""}` : ""}`);
  rows.push(`₹${inr(item.amount)} ÷ ${Math.round(check.units * 100) / 100} ${uw}s = ₹${inr(check.perUnit, 3)} per ${uw}`);
  if (check.ceiling) {
    const c = check.ceiling;
    rows.push(`NPPA: ${c.medicine}, ${c.dosage}, ${c.unitText}: ceiling ₹${inr(c.ceiling)} (excl. GST)`);
    rows.push(`Limit = ₹${inr(c.ceiling)} × ${(1 + check.gstRate).toFixed(2)} = ₹${inr(c.limit, 3)} per ${uw}${check.gstAssumed ? " (GST assumed 5%)" : ` (GST ${Math.round(check.gstRate * 100)}% from bill)`}`);
    rows.push(`${t("calcSource")}: ${c.so}, ${c.list} list, Sl. No. ${c.sl}, effective 1 Apr 2026`);
  }
  if (check.mrpCheck) rows.push(`Charged per pack ₹${inr(check.mrpCheck.perPack)} vs MRP ₹${inr(check.mrpCheck.mrp)}`);
  if (check.generic) rows.push(`Jan Aushadhi: ₹${inr(check.generic.mrp)} for ${check.generic.unitSize} = ₹${inr(check.generic.perUnit, 3)} per ${uw}; (₹${inr(check.perUnit, 3)} − ₹${inr(check.generic.perUnit, 3)}) × ${Math.round(check.units)} = ₹${inr(check.savings)}`);
  if (check.ambiguousStrength) rows.push("Several strengths of this brand fit the printed name; flags are shown only if they hold for all of them.");
  return `<div class="calc"><ul>${rows.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>${check.gstAssumed && check.ceiling ? `<p class="small">${esc(t("gstAssumedNote"))}</p>` : ""}</div>`;
}

function editBlock(l, i) {
  const it = l.item;
  const alts = (l.alternatives || []).filter((a) => !l.match || a.label !== l.match.label || a.key !== l.match.key);
  return `
  <form class="edit" data-i="${i}" onsubmit="return false">
    <label class="wide">${esc(t("fName"))}<input name="name" value="${esc(it.name)}" autocomplete="off" /></label>
    <label>${esc(t("fQty"))}<input name="qty" inputmode="decimal" value="${esc(it.qty ?? "")}" /></label>
    <label>${esc(t("fRate"))}<input name="rate" inputmode="decimal" value="${esc(it.rate ?? "")}" /></label>
    <label>${esc(t("fAmount"))}<input name="amount" inputmode="decimal" value="${esc(it.amount ?? "")}" /></label>
    <label>${esc(t("fMrp"))}<input name="mrp" inputmode="decimal" value="${esc(it.mrp ?? "")}" /></label>
    <label>${esc(t("fPack"))}<input name="pack" inputmode="numeric" value="${esc(it.pack ?? l.check?.pack ?? "")}" /></label>
    <fieldset class="wide"><legend>${esc(t("fBasis"))}</legend>
      <label class="radio"><input type="radio" name="basis" value="pack" ${l.check?.basis === "pack" ? "checked" : ""}/> ${esc(t("perStrip"))}</label>
      <label class="radio"><input type="radio" name="basis" value="unit" ${l.check?.basis === "unit" ? "checked" : ""}/> ${esc(t("perUnit"))}</label>
    </fieldset>
    ${alts.length ? `<div class="wide alts"><span class="lbl">${esc(t("otherMatches"))}</span>${alts.slice(0, 4).map((a, k) => `<button class="alt" data-act="alt" data-i="${i}" data-k="${k}">${esc(a.kind === "brand" ? a.label : prettyKey(a.key))} <small>${esc(prettyKey(a.key))}</small></button>`).join("")}</div>` : ""}
    <div class="wide row"><button class="btn small" data-act="apply" data-i="${i}">${esc(t("done"))}</button><button class="link danger" data-act="remove" data-i="${i}">${esc(t("remove"))}</button></div>
  </form>`;
}

function resultView() {
  const s = state.summary || { total: 0, overcharge: 0, savings: 0, flagged: 0 };
  const n = state.lines.length;
  const paidOnGeneric = state.lines.reduce((acc, l) => acc + (l.check?.savings ? l.item.amount || 0 : 0), 0);
  const savePct = paidOnGeneric ? Math.round((100 * s.savings) / paidOnGeneric) : 0;
  const anyFlag = s.flagged > 0;
  return `
  <main class="result">
    <aside class="side">
      ${state.photoUrl ? `<div class="photo small-photo"><img src="${state.photoUrl}" alt="" /></div>` : ""}
    </aside>
    <div class="main-col">
      <section class="summary" aria-label="Summary">
        <div class="paid-big"><span class="lbl">${esc(t("youPaid"))}</span><span class="big">₹${inr(s.total)}</span>
          <span class="small">${esc(t("linesRead", n))}${s.totalNote === "matches bill total" ? ` · ${esc(t("totalMatches"))}` : ""}</span>
          ${s.totalNote === "bill total differs" ? `<span class="warn">${esc(t("totalDiffers", inr(s.billTotal)))}</span>` : ""}
        </div>
        <div class="two">
          <div class="fig ${anyFlag ? "bad" : "good"}">
            <span class="lbl">${esc(t("possibleOver"))}</span>
            ${anyFlag ? `<span class="big">₹${inr(s.overcharge)}</span><span class="small">${esc(t("onLines", s.flagged))}</span>` : `<span class="mid">${esc(t("noOver"))}</span>`}
          </div>
          <div class="fig save">
            <span class="lbl">${esc(t("couldSave"))}</span>
            ${s.savings > 0.5 ? `<span class="big">₹${inr0(s.savings)}</span><span class="small">${esc(t("savePct", savePct))}</span>` : `<span class="mid">${esc(t("noSave"))}</span>`}
          </div>
        </div>
        ${anyFlag ? `<p class="honest">${esc(t("flagsHonest"))}</p>` : ""}
        <div class="share-row">
          <button class="btn primary" data-act="share">${esc(t("share"))}</button>
          <a class="btn ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(shareText(state, t))}">${esc(t("shareWhatsApp"))}</a>
        </div>
      </section>
      ${n === 0 && !state.manual ? `<p class="warn">${esc(t("readFailed"))}</p>` : ""}
      <section class="lines">
        <h2>${esc(t("medicines"))}</h2>
        ${state.lines.map(lineCard).join("")}
        <form class="add" data-act-form="add" onsubmit="return false">
          <label>${esc(t("searchMed"))}<input name="name" placeholder="Dolo 650 tab" autocomplete="off" /></label>
          <label>${esc(t("fQty"))}<input name="qty" inputmode="numeric" placeholder="15" /></label>
          <label>${esc(t("fAmount"))}<input name="amount" inputmode="decimal" placeholder="31.00" /></label>
          <button class="btn small" data-act="add">${esc(t("addLine"))}</button>
        </form>
        <p class="note">${esc(t("switchNote"))}</p>
      </section>
      <section class="next-steps">
        <h2>${esc(t("whatNow"))}</h2>
        <ol>
          ${anyFlag ? `<li>${esc(t("act_keep"))}</li><li>${esc(t("act_ask"))}</li><li>${esc(t("act_complain"))} <a href="https://nppa.gov.in/en/pharma_sahi_daam" target="_blank" rel="noopener">${esc(t("openSahiDaam"))}</a></li><li>${esc(t("act_helpline"))} <a href="tel:1800111255">1800 111 255</a></li>` : ""}
          <li>${esc(t("act_kendra"))} <a href="https://janaushadhi.gov.in/locate-kendra" target="_blank" rel="noopener">${esc(t("openKendra"))}</a></li>
        </ol>
      </section>
      <button class="btn ghost wide-btn" data-act="home">${esc(t("startOver"))}</button>
    </div>
  </main>`;
}

function aboutView() {
  const info = state.info;
  const meta = info?.meta;
  return `
  <main class="about">
    <h1>${esc(t("sources"))}</h1>
    <h2>How it works</h2>
    <ol>
      <li>The photo is straightened (skew estimate from text rows), flattened against uneven light and cleared of table rules, all in your browser.</li>
      <li>Tesseract.js (LSTM English model, ~3 MB, cached on your device) reads the text.</li>
      <li>Bill lines are found from the column header, token shapes (batch, expiry, pack) and arithmetic: quantity × rate must equal the amount. This also repairs dropped decimal points.</li>
      <li>Each name is matched against ${info ? info.brands.toLocaleString("en-IN") : "~244,000"} Indian brand entries by a trained matcher: trigram retrieval, then a learned scorer over OCR-tolerant features. It finds the salt and strength.</li>
      <li>The salt, strength and dosage form are compared with the NPPA ceiling list and the Jan Aushadhi product list.</li>
    </ol>
    <h2>Price rule used</h2>
    <p>NPPA ceiling prices are per unit (one tablet, one capsule, one ml) and exclude GST. Note (d) of S.O. 1575(E) says manufacturers selling above "the ceiling price (plus Goods and Services Taxes as applicable)" must revise prices down. Bill Lens flags a line when the price you paid per unit is above ceiling × (1 + GST). GST is taken from the bill line when printed, otherwise 5%, the rate for most medicines since 22 September 2025 (PIB). A flag is a prompt to check, not a finding.</p>
    <h2>Data</h2>
    <ul>
      <li>NPPA, S.O. 1575(E) dated 25 Mar 2026: revised ceiling prices of 767 scheduled formulations (NLEM 2022), effective 1 Apr 2026. <a href="https://nppa.gov.in/storage/uploads/tender/0fd8be342c35d5a46a13b281cadc5e4f.pdf" target="_blank" rel="noopener">PDF</a></li>
      <li>NPPA, S.O. 1581(E): revised ceiling prices of 138 scheduled formulations (NLEM 2015), effective 1 Apr 2026. <a href="https://nppa.gov.in/storage/uploads/tender/0d883ca9b600c8a13cec452376176fc4.pdf" target="_blank" rel="noopener">PDF</a></li>
      <li>PMBJP Jan Aushadhi "Product &amp; MRP List", ${meta ? meta.pmbjp.reported_total : 2453} products, fetched ${meta ? meta.pmbjp.fetched_at.slice(0, 10) : "2026-11-16"} from <a href="https://janaushadhi.gov.in/product-portfolio/product-mrp-list" target="_blank" rel="noopener">janaushadhi.gov.in</a>.</li>
      <li>Brand to composition table: Indian Medicine Dataset by JuniorAlive (MIT licence), <a href="https://github.com/junioralive/Indian-Medicine-Dataset" target="_blank" rel="noopener">GitHub</a>. Used only to map a brand name to its salts and strengths; its prices are not used.</li>
    </ul>
    <h2>Limits</h2>
    <ul>
      <li>Printed bills only. Handwritten bills are not supported.</li>
      <li>Accuracy figures come from synthetic bill photos made for testing, not from real customers' bills.</li>
      <li>Only scheduled formulations have NPPA ceiling prices. For other medicines only the printed MRP can be checked.</li>
      <li>Brand data may be out of date or miss new brands; you can correct any line.</li>
      <li>This is not medical or legal advice. Ask a doctor or pharmacist before switching medicines.</li>
    </ul>
    <button class="btn ghost" data-act="home">${esc(t("startOver"))}</button>
  </main>`;
}

function render() {
  document.documentElement.lang = getLang();
  const app = document.getElementById("app");
  const view = state.view === "home" ? homeView() : state.view === "working" ? workingView() : state.view === "result" ? resultView() : aboutView();
  app.innerHTML = header() + view + `<footer class="foot">${esc(t("footer"))}</footer>` + (state.error ? `<div class="toast" role="alert">${esc(state.error)}</div>` : "");
  const file = document.getElementById("file");
  if (file) file.addEventListener("change", (e) => e.target.files[0] && runImage(e.target.files[0]));
}

// ---------- flow ----------
async function fileToCanvas(blob) {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

async function runImage(blob) {
  state.error = null;
  state.manual = false;
  if (state.photoUrl && state.photoUrl.startsWith("blob:")) URL.revokeObjectURL(state.photoUrl);
  state.photoUrl = URL.createObjectURL(blob);
  state.view = "working";
  state.step = "prepare";
  state.recogPct = 0;
  render();
  try {
    const canvas = await fileToCanvas(blob);
    const ctx = canvas.getContext("2d");
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cleaned = await rpc("clean", { image: { data: id.data, width: id.width, height: id.height } }, [id.data.buffer]);
    const out = new ImageData(new Uint8ClampedArray(cleaned.image.data), cleaned.image.width, cleaned.image.height);
    ctx.putImageData(out, 0, 0);
    setStep("read");
    const ocr = await recognise(canvas);
    setStep("find");
    await dataInit;
    const res = await rpc("analyse", { lines: ocr.lines });
    setStep("check");
    state.lines = res.lines;
    state.billTotal = res.parsed.total;
    state.hint = res.parsed.rateBasisHint;
    state.summary = res.summary;
    state.openCalc = new Set();
    state.editing = null;
    state.view = "result";
    render();
    window.scrollTo({ top: 0 });
  } catch (e) {
    console.error(e);
    state.error = String(e.message || e);
    state.view = "home";
    render();
  }
}

function setStep(s) {
  state.step = s;
  if (state.view === "working") render();
}

async function refreshSummary() {
  state.summary = await rpc("summary", { lines: state.lines, billTotal: state.billTotal });
}

function num(v) {
  if (v === "" || v == null) return null;
  const x = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : null;
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const i = el.dataset.i != null ? +el.dataset.i : null;
  if (act === "home") { state.view = "home"; state.error = null; render(); window.scrollTo({ top: 0 }); }
  else if (act === "about") { state.view = "about"; render(); window.scrollTo({ top: 0 }); }
  else if (act === "lang") { setLang(getLang() === "en" ? "hi" : "en"); render(); }
  else if (act === "sample") {
    const s = SAMPLES.find((x) => x.id === el.dataset.id);
    state.sample = s.id;
    const blob = await (await fetch(BASE + s.file)).blob();
    runImage(blob);
  } else if (act === "manual") {
    await dataInit;
    state.manual = true;
    state.photoUrl = null;
    state.lines = [];
    state.billTotal = null;
    state.summary = await rpc("summary", { lines: [], billTotal: null });
    state.view = "result";
    render();
    document.querySelector(".add input")?.focus();
  } else if (act === "calc") {
    state.openCalc.has(i) ? state.openCalc.delete(i) : state.openCalc.add(i);
    render();
  } else if (act === "edit") {
    state.editing = state.editing === i ? null : i;
    render();
    document.querySelector(`#line-${i} input[name=name]`)?.focus();
  } else if (act === "apply") {
    const form = el.closest("form");
    const fd = new FormData(form);
    const old = state.lines[i];
    const item = { ...old.item, name: fd.get("name").trim(), qty: num(fd.get("qty")), rate: num(fd.get("rate")), amount: num(fd.get("amount")), mrp: num(fd.get("mrp")), pack: num(fd.get("pack")), basis: fd.get("basis") || undefined, consistent: true };
    if (item.amount == null && item.qty != null && item.rate != null) item.amount = +(item.qty * item.rate).toFixed(2);
    const keepMatch = item.name === old.item.name && old.match ? { ...old.match, pack: item.pack || old.match.pack } : null;
    state.lines[i] = await rpc("item", { item, hint: state.hint, forced: keepMatch });
    state.editing = null;
    await refreshSummary();
    render();
  } else if (act === "alt") {
    const l = state.lines[i];
    const alts = (l.alternatives || []).filter((a) => !l.match || a.label !== l.match.label || a.key !== l.match.key);
    const pick = { ...alts[+el.dataset.k], prob: 0.95 };
    state.lines[i] = { ...(await rpc("item", { item: l.item, hint: state.hint, forced: pick })), alternatives: l.alternatives };
    state.editing = null;
    await refreshSummary();
    render();
  } else if (act === "remove") {
    state.lines.splice(i, 1);
    state.editing = null;
    await refreshSummary();
    render();
  } else if (act === "add") {
    const fd = new FormData(el.closest("form"));
    const name = String(fd.get("name") || "").trim();
    if (!name) return;
    const qty = num(fd.get("qty")) ?? 1;
    const amount = num(fd.get("amount"));
    const item = { name, qty, amount, rate: amount != null ? +(amount / qty).toFixed(2) : null, mrp: null, pack: null, consistent: true, basis: "unit" };
    state.lines.push(await rpc("item", { item, hint: "unit" }));
    await refreshSummary();
    render();
  } else if (act === "share") {
    const blob = await renderShareCard(state, t);
    const file = new File([blob], "bill-lens-summary.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: shareText(state, t) }); } catch { /* cancelled */ }
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "bill-lens-summary.png";
      a.click();
    }
  }
});

render();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
}
