"""Render the three sample bills shown in the app ("Try a sample bill").

All three are synthetic: fictional pharmacies, dummy registration numbers.
Medicine names are real brands; the prices are invented for the demo. Where a
line is "overcharged", it is the fictional pharmacy charging more than the
MRP printed on its own bill and more than the NPPA limit.

  python eval/make_samples.py   -> app/public/samples/*.jpg + eval/samples_truth.json
"""
import asyncio
import json
import pathlib
import random
import sys

import cv2

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import gen_bills as G  # noqa: E402

OUT = G.ROOT / "app" / "public" / "samples"


def item(pools, label, qty, mrp_factor=None, mrp=None, rate=None):
    pool_common, pool_random, nk = pools
    it = next(dict(x) for x in pool_common + pool_random if x["label"].lower() == label.lower())
    ce = nk.get((it["key"], it["form"]))
    it["ceiling"] = ce[0]["ceiling"] if ce else None
    it["nppa_id"] = ce[0]["id"] if ce else None
    it["qty_strips"] = qty
    if mrp is None:
        mrp = round(it["ceiling"] * 1.05 * it["pack"] * mrp_factor, 2)
    it["mrp_pack"] = mrp
    it["rate_pack"] = rate if rate is not None else mrp
    it["pool"] = "common"
    return it


def main():
    pools = G.load()
    # obviously invented names, so no real shop is implied
    G.PHARMACIES[:] = [("Demo Medicos", "Shop 0, Sample Market, Example Nagar")]
    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(2026)
    specs = []
    # 1) chemist GST invoice with two overcharged lines
    items = [
        item(pools, "Augmentin 625 Duo", 1, mrp_factor=0.93, rate=268.00),   # above MRP and above NPPA limit
        item(pools, "Telma 40", 1, mrp_factor=0.92),
        item(pools, "Dolo 650", 2, mrp_factor=0.9, rate=36.50),              # above MRP and above NPPA limit
        item(pools, "Pan 40", 1, mrp=168.00),                                # not scheduled: MRP check only
        item(pools, "Montair 10", 1, mrp_factor=0.88),
    ]
    specs.append(("sample-overcharge", G.make_bill(rng, 0, "sample", pools, template="gst", fixed_items=items)))
    # 2) thermal receipt, everything within limits, generics cheaper
    items = [
        item(pools, "Glycomet 500 SR", 2, mrp=42.00),
        item(pools, "Amlong", 2, mrp_factor=0.95),
        item(pools, "Storvas 10", 1, mrp_factor=0.9),
        item(pools, "Ecosprin 75", 2, mrp_factor=0.85),
        item(pools, "Thyronorm 50mcg", 1, mrp_factor=0.7),
    ]
    G.PHARMACIES[:] = [("Example Chemists", "1 Placeholder Road, Demo Colony")]
    specs.append(("sample-clean", G.make_bill(rng, 1, "sample", pools, template="thermal", fixed_items=items)))
    # 3) hospital pharmacy statement, one line above the NPPA limit
    items = [
        item(pools, "Cefakind 500", 1, mrp_factor=0.9),
        item(pools, "Ondem 4", 1, mrp_factor=0.9, rate=round(5.26 * 1.05 * 10 * 1.45, 2)),
        item(pools, "Azithral 500", 1, mrp_factor=0.92),
        item(pools, "Calpol 650mg", 1, mrp_factor=0.9),
        item(pools, "Rablet 20", 1, mrp=150.00),
    ]
    G.PHARMACIES[:] = [("Specimen Hospital", "Sample Campus, Example City")]
    specs.append(("sample-hospital", G.make_bill(rng, 2, "sample", pools, template="hospital", fixed_items=items)))

    for it_list in [s[1]["items"] for s in specs]:
        pass
    render = [dict(s, id=name) for name, s in specs]
    asyncio.run(G.render_all(render, OUT))
    truth = []
    for s in render:
        img = cv2.imread(str(OUT / f"{s['id']}.png"))
        enc = G.camera(img, rng, strength=0.8)
        (OUT / f"{s['id']}.jpg").write_bytes(enc.tobytes())
        (OUT / f"{s['id']}.png").unlink()
        truth.append({k: v for k, v in s.items() if k not in ("css", "body")})
    (G.ROOT / "eval" / "samples_truth.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
    for s in truth:
        print(s["id"], s["template"], [(i["label"], i["overcharged"]) for i in s["items"]])


if __name__ == "__main__":
    main()
