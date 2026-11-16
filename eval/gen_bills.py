"""Render synthetic Indian pharmacy bills with ground truth.

Each bill is fictional: invented pharmacy, dummy GSTIN/licence numbers, and a
"synthetic sample" footer. Medicine names are real brands taken from the brand
table so that the matcher is tested on real vocabulary; prices are generated
from the NPPA ceiling (compliant lines) or deliberately inflated by the
fictional pharmacy (overcharge lines).

Usage:
  python eval/gen_bills.py --split train --n 40 --seed 1
  python eval/gen_bills.py --split dev   --n 15 --seed 2
  python eval/gen_bills.py --split test  --n 60 --seed 3     (held out)
  python eval/gen_bills.py --samples                          (the in-app sample bills)

Output: eval/bills/<split>/<id>.jpg (camera-like photo), <id>.png (clean render), truth.json
"""
import argparse
import asyncio
import html
import json
import math
import pathlib
import random

import cv2
import numpy as np
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "app" / "public" / "data"
OUTROOT = ROOT / "eval" / "bills"

GST = 0.05  # GST on most medicines since 22 Sep 2025 (see README)

COMMON = [
    "Dolo 650", "Calpol 650mg", "Telma 40", "Telmikind 40", "Amlong", "Amlokind 5", "Stamlo 5", "Amlopres 5",
    "Augmentin 625 Duo", "Clavam 625", "Moxikind-CV 625", "Azithral 500", "Ecosprin 75", "Thyronorm 50mcg",
    "Thyrox 50", "Amaryl 1mg", "Glimisave 1", "Storvas 10", "Lipvas 10", "Atocor 10", "Taxim-O 200", "Zifi 200",
    "Cetzine", "Okacet", "Cetcip", "Montair 10", "Ondem 4", "Emeset 4", "Novamox 500", "Levoflox 500",
    "Ciplox 500", "Flagyl 400", "Metrogyl 400", "Cardace 5", "Asthalin 4", "Ocid 20", "Ibugesic 400", "Brufen 400",
    "Cefakind 500", "Pan 40", "Rosuvas 10", "Allegra 120mg", "Montek LC", "Glycomet 500 SR", "Losar 50",
    "Repace 50", "Aten 50", "Gemer 1", "Nexpro 40", "Razo 20", "Rablet 20", "Avil 25", "Combiflam", "Rantac 150",
    "Metsmall 500",
]

PHARMACIES = [
    ("Navjeevan Medicos", "Shop 4, Sector 9 Market, Sample Nagar"),
    ("Sanjivani Chemists", "12 Station Road, Demo Colony"),
    ("Arogya Pharmacy", "Plot 21, Example Layout, Ward 7"),
    ("Shubham Medical Hall", "Main Bazaar, Opp. Bus Stand"),
    ("Care Plus Pharmacy", "Ground Floor, Specimen Complex"),
    ("Mahalaxmi Medical Store", "8 Temple Street, Model Town"),
]
PATIENTS = ["Mr. R. Sharma", "Mrs. S. Iyer", "Mr. A. Khan", "Mrs. P. Devi", "Mr. K. Reddy", "Ms. N. Kaur", "Mr. V. Patil", "Mrs. M. Das"]
DOCTORS = ["Dr. A. Mehta", "Dr. S. Rao", "Dr. P. Nair", "Dr. R. Gupta", "Dr. F. Ali"]


def load():
    brands = json.loads((DATA / "brands.json").read_text(encoding="utf-8"))
    nppa = json.loads((DATA / "nppa.json").read_text(encoding="utf-8"))
    forms = brands["forms"]
    nk = {}
    for e in nppa:
        if e["unit"]["kind"] != "unit":
            continue
        nk.setdefault((e["key"], e["form"]), []).append(e)
    for k in nk:
        nk[k].sort(key=lambda e: (e["list"] != "NLEM 2022", e["sl"]))
    pool_common, pool_random = [], []
    by_label = {}
    for r in brands["rows"]:
        f = forms[r[1]]
        if f not in ("tab", "cap", "tab_mr", "cap_mr") or not r[3] or r[3] > 60:
            continue
        item = {"label": r[0], "form": f, "key": brands["comps"][r[2]], "pack": r[3]}
        by_label.setdefault(r[0].lower(), item)
        if any(ch.isdigit() for ch in item["key"]) and len(r[0]) <= 26:
            pool_random.append(item)
    for name in COMMON:
        it = by_label.get(name.lower())
        if it:
            pool_common.append(it)
    return pool_common, pool_random, nk


def money(x):
    return f"{x:.2f}"


def pick_items(rng, pool_common, pool_random, nk, n):
    items = []
    used = set()
    while len(items) < n:
        common = rng.random() < 0.65
        it = rng.choice(pool_common if common else pool_random)
        if it["label"].lower() in used:
            continue
        used.add(it["label"].lower())
        items.append(dict(it, pool="common" if common else "random"))
    for it in items:
        ce = nk.get((it["key"], it["form"]))
        it["ceiling"] = ce[0]["ceiling"] if ce else None
        it["nppa_id"] = ce[0]["id"] if ce else None
    return items


def price_items(rng, items, mode, has_mrp):
    """mode: 'clean' or 'mixed'. Returns items with mrp/rate per pack and flags."""
    for it in items:
        pack = it["pack"]
        c = it["ceiling"]
        if c:
            mrp_unit = c * (1 + GST) * rng.uniform(0.55, 0.97)
        else:
            mrp_unit = rng.uniform(1.5, 25.0)
        it["mrp_pack"] = round(mrp_unit * pack, 2)
        it["rate_pack"] = it["mrp_pack"]
        it["inject"] = None
    if mode == "mixed":
        cands = list(range(len(items)))
        rng.shuffle(cands)
        n_inj = max(1, int(round(len(items) * rng.uniform(0.2, 0.4))))
        for idx in cands[:n_inj]:
            it = items[idx]
            if it["ceiling"] and (not has_mrp or rng.random() < 0.7):
                it["rate_pack"] = round(it["ceiling"] * (1 + GST) * it["pack"] * rng.uniform(1.15, 1.6), 2)
                it["inject"] = "ceiling"
            elif has_mrp:
                it["rate_pack"] = round(it["mrp_pack"] * rng.uniform(1.08, 1.3), 2)
                it["inject"] = "mrp"
    for it in items:
        unit_rate = it["rate_pack"] / it["pack"]
        it["over_ceiling"] = bool(it["ceiling"] and unit_rate > it["ceiling"] * (1 + GST) + 0.005)
        it["over_mrp"] = bool(has_mrp and it["rate_pack"] > it["mrp_pack"] + 0.005)
    return items


def display_name(rng, it, style):
    form = {"tab": "TAB", "tab_mr": "TAB", "cap": "CAP", "cap_mr": "CAP"}[it["form"]]
    name = it["label"]
    if style == "upper":
        return f"{name.upper()} {form}"
    if style == "title":
        return f"{name} {form.title()}"
    return f"{name.upper()} {form} {it['pack']}'S"


def batch(rng):
    return "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(2)) + str(rng.randint(1000, 99999))


def expiry(rng):
    return f"{rng.randint(1, 12):02d}/{rng.choice([27, 28, 29])}"


CSS_BASE = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #fff; }
.bill { background: #fbfaf6; color: #1a1a1a; }
.foot-sample { font-size: 10px; color: #777; margin-top: 10px; text-align: center; letter-spacing: .02em; }
table { border-collapse: collapse; width: 100%; }
"""


def tpl_thermal(rng, ph, items, meta):
    """Narrow thermal receipt, qty in tablets, rate per tablet, no MRP column."""
    font = rng.choice(["Consolas", "Courier New", "Lucida Console"])
    rows = []
    total = 0.0
    lines = []
    for i, it in enumerate(items):
        units = it["qty_strips"] * it["pack"]
        unit_rate = round(it["rate_pack"] / it["pack"], 2)
        amt = round(units * unit_rate, 2)
        total += amt
        lines.append({"qty": units, "qty_unit": "unit", "rate": unit_rate, "rate_basis": "unit", "amount": amt, "mrp": None})
        nm = display_name(rng, it, "upper")
        rows.append(f"<tr><td colspan=4 class=nm>{html.escape(nm)}</td></tr>"
                    f"<tr class=sub><td>B:{batch(rng)} E:{expiry(rng)}</td><td class=r>{units}</td><td class=r>{money(unit_rate)}</td><td class=r>{money(amt)}</td></tr>")
    gst_note = f"Incl. GST {money(total - total / 1.05)}"
    body = f"""
<div class=bill style="width:430px;padding:22px 20px;font-family:'{font}',monospace;font-size:15px;line-height:1.35">
 <div style="text-align:center;font-weight:bold;font-size:18px">{html.escape(ph[0].upper())}</div>
 <div style="text-align:center">{html.escape(ph[1])}</div>
 <div style="text-align:center">GSTIN: 00SAMPLE0000X0Z0  DL: SAMPLE-20B-0000</div>
 <div class=hr></div>
 <div>Bill No: {meta['no']}   Date: {meta['date']}</div>
 <div>Patient: {html.escape(meta['patient'])}</div>
 <div class=hr></div>
 <table><tr class=hd><td>Item</td><td class=r>Qty</td><td class=r>Rate</td><td class=r>Amount</td></tr>
 {''.join(rows)}</table>
 <div class=hr></div>
 <table><tr><td><b>NET AMOUNT</b></td><td class=r><b>Rs {money(total)}</b></td></tr>
 <tr><td>{gst_note}</td><td></td></tr></table>
 <div class=hr></div>
 <div style="text-align:center">Get well soon. Goods once sold will not be taken back.</div>
 <div class=foot-sample>SYNTHETIC SAMPLE BILL - FICTIONAL PHARMACY</div>
</div>"""
    css = CSS_BASE + ".hr{border-top:1px dashed #333;margin:6px 0}.r{text-align:right}.nm{padding-top:5px}.sub td{font-size:14px}.hd td{font-weight:bold}"
    return css, body, lines, total


def tpl_gst_invoice(rng, ph, items, meta):
    """A5 GST invoice with Pack, Batch, Exp, Qty (strips), MRP, Rate, GST%, Amount."""
    font = rng.choice(["Arial", "Tahoma", "Verdana", "Calibri", "Segoe UI"])
    rows, lines, total = [], [], 0.0
    for i, it in enumerate(items, 1):
        q = it["qty_strips"]
        amt = round(q * it["rate_pack"], 2)
        total += amt
        lines.append({"qty": q, "qty_unit": "pack", "rate": it["rate_pack"], "rate_basis": "pack", "amount": amt, "mrp": it["mrp_pack"]})
        rows.append(f"<tr><td>{i}</td><td class=l>{html.escape(display_name(rng, it, 'upper'))}</td><td>1x{it['pack']}</td><td>{batch(rng)}</td><td>{expiry(rng)}</td>"
                    f"<td class=r>{q}</td><td class=r>{money(it['mrp_pack'])}</td><td class=r>{money(it['rate_pack'])}</td><td class=r>5</td><td class=r>{money(amt)}</td></tr>")
    body = f"""
<div class=bill style="width:900px;padding:26px 28px;font-family:'{font}',sans-serif;font-size:15px">
 <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #222;padding-bottom:8px">
  <div><div style="font-size:24px;font-weight:bold">{html.escape(ph[0])}</div><div>{html.escape(ph[1])}</div>
  <div>GSTIN 00SAMPLE0000X0Z0 | D.L. No. SAMPLE-20-21/0000</div></div>
  <div style="text-align:right"><div style="font-size:18px;font-weight:bold">TAX INVOICE</div><div>Inv No: {meta['no']}</div><div>Date: {meta['date']}</div></div>
 </div>
 <div style="display:flex;justify-content:space-between;margin:8px 0">
  <div>Patient: {html.escape(meta['patient'])}</div><div>Prescribed by: {html.escape(meta['doctor'])}</div></div>
 <table class=t>
  <tr class=hd><td>Sr</td><td class=l>Product Name</td><td>Pack</td><td>Batch</td><td>Exp</td><td class=r>Qty</td><td class=r>MRP</td><td class=r>Rate</td><td class=r>GST%</td><td class=r>Amount</td></tr>
  {''.join(rows)}
 </table>
 <div style="display:flex;justify-content:flex-end;margin-top:10px">
  <table style="width:320px"><tr><td>Taxable value</td><td class=r>{money(total / 1.05)}</td></tr>
  <tr><td>CGST 2.5% + SGST 2.5%</td><td class=r>{money(total - total / 1.05)}</td></tr>
  <tr style="font-weight:bold;font-size:17px"><td>Grand Total</td><td class=r>Rs. {money(total)}</td></tr></table></div>
 <div style="margin-top:14px;font-size:13px">E.&amp;O.E. Subject to local jurisdiction. Pharmacist signature</div>
 <div class=foot-sample>SYNTHETIC SAMPLE BILL - FICTIONAL PHARMACY - NOT A REAL TRANSACTION</div>
</div>"""
    css = CSS_BASE + ".t td{border-bottom:1px solid #bbb;padding:5px 4px;text-align:center}.t .l{text-align:left}.r{text-align:right!important}.hd td{font-weight:bold;border-bottom:2px solid #222;background:#efede6}"
    return css, body, lines, total


def tpl_chemist(rng, ph, items, meta):
    """Chemist cash memo: Qty (strips), Description, Batch, Exp, MRP, Disc%, Amount (rate implied)."""
    font = rng.choice(["Times New Roman", "Georgia", "Cambria", "Arial"])
    rows, lines, total = [], [], 0.0
    disc = rng.choice([0, 0, 5, 10])
    for it in items:
        q = it["qty_strips"]
        # Charged rate per strip after discount
        rate = round(it["rate_pack"] * (1 - disc / 100), 2)
        amt = round(q * rate, 2)
        total += amt
        lines.append({"qty": q, "qty_unit": "pack", "rate": rate, "rate_basis": "pack", "amount": amt, "mrp": it["mrp_pack"], "printed_rate": None})
        rows.append(f"<tr><td class=r>{q}</td><td class=l>{html.escape(display_name(rng, it, 'title'))}</td><td>{batch(rng)}</td><td>{expiry(rng)}</td>"
                    f"<td class=r>{money(it['mrp_pack'])}</td><td class=r>{money(it['rate_pack'])}</td><td class=r>{disc}</td><td class=r>{money(amt)}</td></tr>")
    body = f"""
<div class=bill style="width:820px;padding:24px 26px;font-family:'{font}',serif;font-size:16px;border:1px solid #999">
 <div style="text-align:center;font-size:26px;font-weight:bold;letter-spacing:.03em">{html.escape(ph[0])}</div>
 <div style="text-align:center">{html.escape(ph[1])} | Ph: 00000 00000</div>
 <div style="text-align:center;font-size:13px">GSTIN: 00SAMPLE0000X0Z0 &nbsp; Lic. No. SAMPLE/RX/0000</div>
 <div style="display:flex;justify-content:space-between;margin:10px 0;border-top:1px solid #333;border-bottom:1px solid #333;padding:4px 0">
  <span>CASH MEMO No. {meta['no']}</span><span>Date {meta['date']}</span></div>
 <div style="margin-bottom:6px">Name: {html.escape(meta['patient'])} &nbsp;&nbsp; Dr: {html.escape(meta['doctor'])}</div>
 <table class=t>
  <tr class=hd><td class=r>Qty</td><td class=l>Description</td><td>Batch</td><td>Exp.</td><td class=r>MRP</td><td class=r>Rate</td><td class=r>Disc%</td><td class=r>Amount</td></tr>
  {''.join(rows)}
 </table>
 <div style="text-align:right;margin-top:10px;font-size:19px;font-weight:bold">Net Payable: Rs. {money(total)}</div>
 <div style="font-size:13px;margin-top:6px">Prices inclusive of GST. Please check expiry before use.</div>
 <div class=foot-sample>SYNTHETIC SAMPLE BILL - FICTIONAL PHARMACY</div>
</div>"""
    css = CSS_BASE + ".t td{padding:5px 5px;text-align:center}.t .l{text-align:left}.r{text-align:right!important}.hd td{font-weight:bold;border-bottom:1px solid #333}"
    return css, body, lines, total


def tpl_hospital(rng, ph, items, meta):
    """Held-out layout: hospital pharmacy statement, units and unit price, different typography."""
    font = rng.choice(["Trebuchet MS", "Palatino Linotype", "Book Antiqua", "Century Gothic"])
    rows, lines, total = [], [], 0.0
    for it in items:
        units = it["qty_strips"] * it["pack"]
        unit_rate = round(it["rate_pack"] / it["pack"], 2)
        amt = round(units * unit_rate, 2)
        total += amt
        lines.append({"qty": units, "qty_unit": "unit", "rate": unit_rate, "rate_basis": "unit", "amount": amt, "mrp": None})
        rows.append(f"<tr><td>{meta['date']}</td><td class=l>{html.escape(display_name(rng, it, 'pack'))}</td><td class=r>{units}</td><td class=r>{money(unit_rate)}</td><td class=r>{money(amt)}</td></tr>")
    body = f"""
<div class=bill style="width:860px;padding:30px 34px;font-family:'{font}',sans-serif;font-size:15px">
 <div style="font-size:22px;font-weight:bold">{html.escape(ph[0])} - In-house Pharmacy</div>
 <div style="color:#444">{html.escape(ph[1])}</div>
 <div style="margin:12px 0 6px;font-size:17px;font-weight:bold">PHARMACY STATEMENT (Medicines)</div>
 <div style="display:flex;gap:40px;margin-bottom:8px"><span>UHID: SAMPLE{rng.randint(100000, 999999)}</span><span>Patient: {html.escape(meta['patient'])}</span><span>Bill: {meta['no']}</span></div>
 <table class=t>
  <tr class=hd><td>Date</td><td class=l>Item Description</td><td class=r>Qty</td><td class=r>Unit Price</td><td class=r>Total</td></tr>
  {''.join(rows)}
  <tr class=tot><td></td><td class=l>Total (Medicines)</td><td></td><td></td><td class=r>{money(total)}</td></tr>
 </table>
 <div style="margin-top:12px;font-size:13px;color:#333">This is a computer generated statement. Prices inclusive of applicable taxes.</div>
 <div class=foot-sample>SYNTHETIC SAMPLE BILL - FICTIONAL HOSPITAL</div>
</div>"""
    css = CSS_BASE + ".t td{padding:6px 6px;border:1px solid #888;text-align:left}.t .r{text-align:right}.hd td{font-weight:bold;background:#e8edf0}.tot td{font-weight:bold}"
    return css, body, lines, total


def tpl_dotmatrix(rng, ph, items, meta):
    """Held-out layout (never used while developing): dot-matrix style invoice with a
    manufacturer column, 'Particulars / Qnty / M.R.P. / Value' headings."""
    font = rng.choice(["Courier New", "Consolas"])
    mfrs = ["CIP", "SUN", "MAN", "ALK", "LUP", "GSK", "MKD", "ZYD", "TOR", "GLN"]
    rows, lines, total = [], [], 0.0
    for i, it in enumerate(items, 1):
        q = it["qty_strips"]
        amt = round(q * it["rate_pack"], 2)
        total += amt
        lines.append({"qty": q, "qty_unit": "pack", "rate": it["rate_pack"], "rate_basis": "pack", "amount": amt, "mrp": it["mrp_pack"]})
        nm = display_name(rng, it, "upper")
        rows.append(f"<tr><td>{i:>2}</td><td class=l>{html.escape(nm)}</td><td>{rng.choice(mfrs)}</td><td>{expiry(rng)}</td><td class=r>{q}</td><td class=r>{money(it['mrp_pack'])}</td><td class=r>{money(it['rate_pack'])}</td><td class=r>{money(amt)}</td></tr>")
    body = f"""
<div class=bill style="width:880px;padding:22px 24px;font-family:'{font}',monospace;font-size:15px;font-weight:600;color:#2a2a3a">
 <div style="text-align:center;font-size:20px">{html.escape(ph[0].upper())}</div>
 <div style="text-align:center">{html.escape(ph[1])}</div>
 <div style="text-align:center">GST NO 00SAMPLE0000X0Z0   D.L.NO SAMPLE/21B/0000</div>
 <div>==========================================================================</div>
 <div>INVOICE: {meta['no']}            DATE: {meta['date']}         PATIENT: {html.escape(meta['patient'].upper())}</div>
 <div>==========================================================================</div>
 <table class=t><tr class=hd><td>SN</td><td class=l>PARTICULARS</td><td>MFR</td><td>EXP</td><td class=r>QNTY</td><td class=r>M.R.P.</td><td class=r>RATE</td><td class=r>VALUE</td></tr>
 {''.join(rows)}</table>
 <div>--------------------------------------------------------------------------</div>
 <div style="text-align:right">NET VALUE (INCL. GST) : {money(total)}</div>
 <div>--------------------------------------------------------------------------</div>
 <div class=foot-sample>SYNTHETIC SAMPLE BILL - FICTIONAL PHARMACY</div>
</div>"""
    css = CSS_BASE + ".t td{padding:3px 4px;text-align:center}.t .l{text-align:left}.r{text-align:right!important}"
    return css, body, lines, total


TEMPLATES = {"dotmatrix": (tpl_dotmatrix, True), "thermal": (tpl_thermal, False), "gst": (tpl_gst_invoice, True), "chemist": (tpl_chemist, True), "hospital": (tpl_hospital, False)}


def camera(img_bgr, rng, strength=1.0):
    """Make a clean render look like a phone photo of paper on a table."""
    h, w = img_bgr.shape[:2]
    pad = int(max(h, w) * 0.12)
    bg_color = np.array(rng.choice([(70, 92, 120), (60, 60, 64), (150, 160, 170), (40, 70, 95), (110, 130, 150)]), dtype=np.float32)
    H, W = h + 2 * pad, w + 2 * pad
    bg = np.ones((H, W, 3), np.float32) * bg_color
    bg += np.random.default_rng(rng.randint(0, 10**9)).normal(0, 6, bg.shape).astype(np.float32)
    # perspective: jitter corners
    j = 0.035 * strength
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[pad + rng.uniform(-j, j) * w, pad + rng.uniform(-j, j) * h],
                      [pad + w + rng.uniform(-j, j) * w, pad + rng.uniform(-j, j) * h],
                      [pad + w + rng.uniform(-j, j) * w, pad + h + rng.uniform(-j, j) * h],
                      [pad + rng.uniform(-j, j) * w, pad + h + rng.uniform(-j, j) * h]])
    ang = math.radians(rng.uniform(-3.0, 3.0) * strength)
    cx, cy = W / 2, H / 2
    rot = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]], np.float32)
    dst = ((dst - [cx, cy]) @ rot.T + [cx, cy]).astype(np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    paper = cv2.warpPerspective(img_bgr.astype(np.float32), M, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
    mask = cv2.warpPerspective(np.ones((h, w), np.float32), M, (W, H), flags=cv2.INTER_LINEAR)
    out = bg * (1 - mask[..., None]) + paper * mask[..., None]
    # lighting: linear gradient + vignette + optional soft shadow band
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    gx, gy = rng.uniform(-1, 1), rng.uniform(-1, 1)
    grad = 1 + 0.18 * strength * ((xx / W - 0.5) * gx + (yy / H - 0.5) * gy)
    vig = 1 - 0.22 * strength * (((xx - cx) / W) ** 2 + ((yy - cy) / H) ** 2) * 2
    light = grad * vig
    if rng.random() < 0.5:
        x0 = rng.uniform(0.2, 0.8) * W
        width = rng.uniform(0.08, 0.2) * W
        band = 1 - 0.18 * strength * np.exp(-((xx - x0 - (yy - cy) * rng.uniform(-0.4, 0.4)) ** 2) / (2 * width ** 2))
        light *= band
    warm = np.array([rng.uniform(0.9, 1.0), rng.uniform(0.95, 1.0), 1.0], np.float32)  # BGR: slight warm cast
    out = out * light[..., None] * warm
    k = rng.choice([3, 5]) if strength > 0.5 else 3
    sigma = rng.uniform(0.5, 1.2) * strength
    if sigma > 0.1:
        out = cv2.GaussianBlur(out, (k, k), sigma)
    out += np.random.default_rng(rng.randint(0, 10**9)).normal(0, 4.0 * strength, out.shape).astype(np.float32)
    out = np.clip(out, 0, 255).astype(np.uint8)
    # phone-like downscale
    target_w = int(rng.uniform(1500, 1900))
    scale = target_w / W
    out = cv2.resize(out, (target_w, int(H * scale)), interpolation=cv2.INTER_AREA)
    q = int(rng.uniform(62, 88))
    ok, enc = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, q])
    return enc


async def render_all(specs, outdir):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(device_scale_factor=2)
        for s in specs:
            await page.set_content(f"<html><head><meta charset=utf-8><style>{s['css']}</style></head><body>{s['body']}</body></html>")
            await page.wait_for_timeout(50)
            el = await page.query_selector(".bill")
            await el.screenshot(path=str(outdir / f"{s['id']}.png"))
        await b.close()


def make_bill(rng, idx, split, pools, template=None, mode=None, n_items=None, fixed_items=None):
    pool_common, pool_random, nk = pools
    tname = template or rng.choice(["thermal", "gst", "chemist"])
    fn, has_mrp = TEMPLATES[tname]
    mode = mode or ("clean" if rng.random() < 0.35 else "mixed")
    n = n_items or rng.randint(3, 8)
    items = fixed_items or pick_items(rng, pool_common, pool_random, nk, n)
    for it in items:
        it.setdefault("qty_strips", rng.choice([1, 1, 1, 2, 2, 3]))
    if not fixed_items:
        price_items(rng, items, mode, has_mrp)
    ph = rng.choice(PHARMACIES)
    meta = {"no": f"{rng.choice(['A', 'B', 'CM', 'INV'])}-{rng.randint(1000, 9999)}",
            "date": f"{rng.randint(1, 28):02d}/{rng.randint(1, 11):02d}/2026",
            "patient": rng.choice(PATIENTS), "doctor": rng.choice(DOCTORS)}
    css, body, lines, total = fn(rng, ph, items, meta)
    truth_items = []
    for it, ln in zip(items, lines):
        # Ground truth is defined on what was actually charged (amount / units bought).
        units = ln["qty"] * (it["pack"] if ln["qty_unit"] == "pack" else 1)
        eff_unit = ln["amount"] / units
        it["over_ceiling"] = bool(it["ceiling"] and eff_unit > it["ceiling"] * (1 + GST) + 0.005)
        it["over_mrp"] = bool(ln["mrp"] and eff_unit * it["pack"] > ln["mrp"] + 0.01)
        truth_items.append({
            "label": it["label"], "pool": it.get("pool"), "key": it["key"], "form": it["form"], "pack": it["pack"],
            "nppa_id": it["nppa_id"], "ceiling": it["ceiling"],
            **ln,
            "over_ceiling": it["over_ceiling"], "over_mrp": it["over_mrp"],
            "overcharged": it["over_ceiling"] or it["over_mrp"],
        })
    bid = f"{split}-{idx:03d}"
    return {"id": bid, "template": tname, "mode": mode, "total": round(total, 2), "items": truth_items, "css": css, "body": body}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="dev")
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--templates", default="thermal,gst,chemist")
    args = ap.parse_args()
    rng = random.Random(args.seed)
    pools = load()
    outdir = OUTROOT / args.split
    outdir.mkdir(parents=True, exist_ok=True)
    temps = args.templates.split(",")
    specs = [make_bill(rng, i, args.split, pools, template=temps[i % len(temps)]) for i in range(args.n)]
    asyncio.run(render_all(specs, outdir))
    for s in specs:
        img = cv2.imread(str(outdir / f"{s['id']}.png"))
        enc = camera(img, rng, strength=rng.choice([0.8, 1.0, 1.0, 1.25]))
        (outdir / f"{s['id']}.jpg").write_bytes(enc.tobytes())
    truth = [{k: v for k, v in s.items() if k not in ("css", "body")} for s in specs]
    (outdir / "truth.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
    n_items = sum(len(s["items"]) for s in specs)
    n_over = sum(it["overcharged"] for s in specs for it in s["items"])
    print(f"{args.split}: {len(specs)} bills, {n_items} lines, {n_over} overcharged lines -> {outdir}")


if __name__ == "__main__":
    main()
