"""Convert the official price lists and the brand table into compact JSON for the app.

Inputs (data/raw/, fetched by scripts/fetch_sources.sh and scripts/fetch_pmbjp.py):
  nppa_nlem2022_767_wpi_2026.pdf   NPPA S.O. 1575(E), 25 Mar 2026 (NLEM 2022, w.e.f. 1 Apr 2026)
  nppa_nlem2015_138_wpi_2026.pdf   NPPA WPI revision of 138 NLEM 2015 formulations (w.e.f. 1 Apr 2026)
  pmbjp_products.json              Jan Aushadhi "Product & MRP List"
  indian_medicine_data.csv         brand -> composition table (MIT licence, see README)

Outputs (app/public/data/):
  nppa.json, pmbjp.json, brands.json, meta.json
"""
import csv
import hashlib
import json
import pathlib
import re
import sys

import pdfplumber

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from medlib import clean_salt, form_class, make_key, strength_tokens  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "app" / "public" / "data"
REPORT = ROOT / "data" / "processed"

NPPA_SOURCES = [
    {
        "file": "nppa_nlem2022_767_wpi_2026.pdf",
        "list": "NLEM 2022",
        "url": "https://nppa.gov.in/storage/uploads/tender/0fd8be342c35d5a46a13b281cadc5e4f.pdf",
        "title": "Notification for revision in ceiling prices of 767 scheduled formulations under NLEM 2022 based on WPI",
        "listed_on": "https://nppa.gov.in/en/view_more?id=4 (27-Mar-2026)",
    },
    {
        "file": "nppa_nlem2015_138_wpi_2026.pdf",
        "list": "NLEM 2015",
        "url": "https://nppa.gov.in/storage/uploads/tender/0d883ca9b600c8a13cec452376176fc4.pdf",
        "title": "Notification for revision in ceiling prices of 138 scheduled formulations under NLEM 2015 based on WPI",
        "listed_on": "https://nppa.gov.in/en/view_more?id=4 (27-Mar-2026)",
    },
]


def sha256(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def is_ascii(s):
    return all(ord(c) < 128 for c in s)


def parse_unit(u):
    t = u.lower().strip()
    m = re.search(r"\((\d+(?:\.\d+)?)\s*ml\)", t)
    if t.startswith("each pack") or "pack" in t:
        return {"kind": "pack", "ml": float(m.group(1)) if m else None}
    if re.search(r"\bml\b", t):
        return {"kind": "ml"}
    if re.search(r"\b(gm|g|gram)\b", t):
        return {"kind": "g"}
    if re.search(r"tablet|capsule|suppository|pessary|lozenge", t):
        return {"kind": "unit"}
    return {"kind": "pack"}


def split_salts(med):
    parts = re.split(r"\s*\+\s*|\s+and\s+", med.replace("\n", " "))
    return [clean_salt(p) for p in parts if p.strip()]


def build_nppa():
    entries, skipped = [], []
    for src in NPPA_SOURCES:
        pdf = pdfplumber.open(RAW / src["file"])
        text0 = "\n".join((pdf.pages[i].extract_text() or "") for i in range(len(pdf.pages)))
        so = re.search(r"S\.O\.\s*(\d+)\s*\(E\)\.?\s*[—-]", text0)
        src["so_number"] = f"S.O. {so.group(1)}(E)" if so else None
        src["sha256"] = sha256(RAW / src["file"])
        last = None
        for page in pdf.pages:
            for tb in page.extract_tables():
                for r in tb:
                    if not r or len(r) < 5:
                        continue
                    cells = [(c or "").replace("\n", " ").strip() for c in r]
                    sl = cells[0]
                    if not sl.isdigit():
                        continue
                    if not is_ascii(cells[1] + cells[2]):
                        continue
                    med, dose, unit, price = cells[1], cells[2], cells[3], cells[4]
                    try:
                        ceiling = float(price.replace(",", ""))
                    except ValueError:
                        skipped.append({"list": src["list"], "sl": sl, "why": "price", "row": cells})
                        continue
                    salts = split_salts(med)
                    strengths = strength_tokens(dose)
                    if len(salts) == len(strengths):
                        pairs = list(zip(salts, strengths))
                    elif len(salts) == 1 and len(strengths) >= 1:
                        pairs = [(salts[0], strengths[0])]
                    else:
                        skipped.append({"list": src["list"], "sl": sl, "why": "strength", "row": cells})
                        continue
                    entries.append({
                        "id": f"{'22' if '2022' in src['list'] else '15'}-{sl}",
                        "list": src["list"],
                        "sl": int(sl),
                        "medicine": re.sub(r"\s+", " ", med),
                        "dosage": re.sub(r"\s+", " ", dose),
                        "unitText": unit,
                        "unit": parse_unit(unit),
                        "form": form_class(dose + " " + unit),
                        "key": make_key(pairs),
                        "ceiling": ceiling,
                        "so": src["so_number"],
                    })
                    last = sl
    return entries, skipped


def parse_pack(unit_size):
    t = unit_size.lower()
    m = re.search(r"(\d+)\s*'?\s*s\b", t) or re.search(r"(\d+)\s*(?:tablets|tabs|capsules|caps)\b", t)
    if m:
        return {"count": int(m.group(1))}
    m = re.search(r"(\d+(?:\.\d+)?)\s*ml", t)
    if m:
        return {"ml": float(m.group(1))}
    m = re.search(r"(\d+(?:\.\d+)?)\s*(g|gm)\b", t)
    if m:
        return {"g": float(m.group(1))}
    return {}


FORM_WORDS = r"(tablets?|capsules?|oral suspension|suspension|syrup|injection|oral solution|solution|cream|ointment|gel|drops?|lotion|powder|granules|suppositor(?:y|ies)|inhaler|spray|elixir|sachets?)"


def parse_pmbjp_name(name):
    n = name.replace(" ", " ")
    n = re.sub(r"\s+", " ", n)
    low = n.lower()
    strengths = strength_tokens(low)
    # remove strengths, pharmacopoeia tags, release modifiers and dosage-form words to get salts
    s = re.sub(r"\(([^)]*)\)", lambda m: " " if re.search(r"release|resistant|coated|aspirin|equivalent|as ", m.group(1)) else m.group(0), low)
    s = re.sub(r"\d+(?:\.\d+)?\s*(mg|mcg|g|gm|iu|%|ml)\b(\s*(per|/)\s*\d*\s*(ml|g|gm))?", " ", s)
    s = re.sub(r"\b(ip|bp|usp|i\.p\.)\b", " ", s)
    s = re.sub(r"\b(prolonged|sustained|extended|modified|controlled|delayed)[- ]release\b", " ", s)
    s = re.sub(r"\b(gastro[- ]resistant|enteric[- ]coated|film[- ]coated|dispersible|chewable|orally disintegrating|mouth dissolving|uncoated|paediatric|pediatric|oral|in flavour base|flavoured|sugar free|per|w/w|w/v)\b", " ", s)
    s = re.sub(r"\b" + FORM_WORDS + r"\b.*$", " ", s)  # everything after the form word is pack text
    salts = [clean_salt(p) for p in re.split(r",|\band\b|\+|\bwith\b", s) if p.strip()]
    salts = [x for x in salts if x and not re.fullmatch(r"[\d. ]*", x)]
    if salts and len(salts) == len(strengths):
        return make_key(list(zip(salts, strengths)))
    if len(salts) == 1 and len(strengths) == 1:
        return make_key([(salts[0], strengths[0])])
    return None


def build_pmbjp():
    d = json.loads((RAW / "pmbjp_products.json").read_text(encoding="utf-8"))
    out, unparsed = [], []
    for r in d["rows"]:
        if not r.get("mrp") or r.get("status") != 1:
            continue
        key = parse_pmbjp_name(r["genericName"])
        if not key:
            unparsed.append(r["genericName"])
            continue
        out.append({
            "code": r["drugCode"],
            "name": re.sub(r"\s+", " ", r["genericName"]).strip(),
            "key": key,
            "form": form_class(r["genericName"]),
            "unitSize": r["unitSize"],
            "pack": parse_pack(r["unitSize"]),
            "mrp": r["mrp"],
            "group": r.get("groupName"),
        })
    return out, unparsed, d


TRAILING_FORM = re.compile(
    r"\s+(tablet|tablets|capsule|capsules|syrup|suspension|oral suspension|injection|infusion|cream|ointment|gel|drops?|oral drops|eye drops?|ear drops?|eye/ear drops?|lotion|solution|oral solution|powder|sachet|granules|inhaler|rotacap|respules?|spray|nasal spray|suppository|expectorant|liquid|soap|shampoo|kit|vaccine|dusting powder|transcaps?|softgel|capsule sr|tablet sr|tablet er|tablet dt|tablet md|tablet cr|tablet xr|tablet pr|tablet xl|tablet mr|tablet dr)(\s+(sr|er|dt|md|cr|xr|pr|xl|mr|dr))?$",
    re.I,
)


def brand_label(name):
    lab = TRAILING_FORM.sub("", name).strip()
    return lab


def parse_brand_pack(label):
    t = label.lower()
    m = re.search(r"of (\d+)\s*(tablet|capsule|tab|cap|softgel|suppositor|pessar|lozenge|sachet|respule|rotacap|transcap)", t)
    if m:
        return {"count": int(m.group(1))}
    m = re.search(r"of (\d+(?:\.\d+)?)\s*ml\b", t)
    if m:
        return {"ml": float(m.group(1))}
    m = re.search(r"of (\d+(?:\.\d+)?)\s*(gm|g)\b", t)
    if m:
        return {"g": float(m.group(1))}
    return {}


def build_brands():
    comps, comp_idx = [], {}
    forms = ["tab", "tab_mr", "cap", "cap_mr", "liquid", "inj", "topical", "eye_ear", "inhal", "supp", "drops", "powder", "other"]
    form_idx = {f: i for i, f in enumerate(forms)}
    rows, seen = [], set()
    with open(RAW / "indian_medicine_data.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["Is_discontinued"] != "FALSE" or r["type"] != "allopathy":
                continue
            pairs, ok = [], True
            for c in (r["short_composition1"], r["short_composition2"]):
                c = c.strip()
                if not c:
                    continue
                m = re.match(r"(.+?)\s*\((.*)\)\s*$", c)
                if not m:
                    ok = False
                    break
                st = strength_tokens(m.group(2))
                pairs.append((clean_salt(m.group(1)), st[0] if st else ""))
            if not ok or not pairs:
                continue
            key = make_key(pairs)
            if key not in comp_idx:
                comp_idx[key] = len(comps)
                comps.append(key)
            label = brand_label(r["name"])
            fc = form_class(r["name"] + " " + r["pack_size_label"])
            pack = parse_brand_pack(r["pack_size_label"])
            sig = (label.lower(), fc, comp_idx[key], pack.get("count"), pack.get("ml"))
            if sig in seen:
                continue
            seen.add(sig)
            rows.append([label, form_idx[fc], comp_idx[key], pack.get("count") or 0, pack.get("ml") or 0])
    return {"forms": forms, "comps": comps, "rows": rows}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    REPORT.mkdir(parents=True, exist_ok=True)
    nppa, skipped = build_nppa()
    pmbjp, unparsed, pm_raw = build_pmbjp()
    brands = build_brands()

    meta = {
        "nppa": {
            "sources": NPPA_SOURCES,
            "effective_from": "2026-04-01",
            "gst_rule": "Ceiling prices are exclusive of GST. Notes (d) and (f) of S.O. 1575(E): sale price may not exceed ceiling price plus GST as applicable, and GST may be added only if actually paid or payable.",
            "rows": len(nppa),
            "skipped": len(skipped),
        },
        "pmbjp": {
            "source": pm_raw["source"],
            "fetched_at": pm_raw["fetched_at"],
            "reported_total": pm_raw["reported_total"],
            "rows_with_mrp_and_parsed": len(pmbjp),
            "unparsed": len(unparsed),
        },
        "brands": {
            "source": "https://github.com/junioralive/Indian-Medicine-Dataset (DATA/indian_medicine_data.csv)",
            "licence": "MIT, Copyright (c) 2024 JuniorAlive",
            "rows": len(brands["rows"]),
            "compositions": len(brands["comps"]),
            "sha256": sha256(RAW / "indian_medicine_data.csv"),
        },
    }

    def dump(name, obj):
        (OUT / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    dump("nppa.json", nppa)
    dump("pmbjp.json", pmbjp)
    dump("brands.json", brands)
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    (REPORT / "nppa_skipped.json").write_text(json.dumps(skipped, indent=1, ensure_ascii=False), encoding="utf-8")
    (REPORT / "pmbjp_unparsed.txt").write_text("\n".join(unparsed), encoding="utf-8")
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
