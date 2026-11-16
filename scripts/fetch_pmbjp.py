"""Fetch the official PMBJP (Jan Aushadhi) "Product & MRP List".

The list is published at https://janaushadhi.gov.in/product-portfolio/product-mrp-list
as a client-rendered table. This script opens that public page in a headless
browser exactly like a visitor would, switches the table to 100 rows per page,
pages through it, and records the JSON the page itself receives.

Output: data/raw/pmbjp_products.json  (list of rows + fetch metadata)
"""
import asyncio
import datetime as dt
import json
import pathlib

from playwright.async_api import async_playwright

URL = "https://janaushadhi.gov.in/product-portfolio/product-mrp-list"
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "raw" / "pmbjp_products.json"


async def main():
    rows = {}
    total = None
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 900})

        async def on_response(resp):
            nonlocal total
            if "getAllProductForWeb" not in resp.url:
                return
            try:
                body = await resp.json()
            except Exception:
                return
            rb = body.get("responseBody") or {}
            total = rb.get("totalElement", total)
            for r in rb.get("newProductResponsesList") or []:
                rows[r["drugCode"]] = r

        page.on("response", on_response)
        await page.goto(URL, wait_until="networkidle", timeout=120000)
        await page.wait_for_timeout(2000)
        await page.select_option('select[aria-label="Rows per page:"]', "100")
        await page.wait_for_timeout(3000)
        for _ in range(60):
            nxt = page.locator("#pagination-next-page")
            if await nxt.get_attribute("aria-disabled") == "true":
                break
            await nxt.click()
            await page.wait_for_timeout(2500)
        await browser.close()

    data = {
        "source": URL,
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "reported_total": total,
        "rows": sorted(rows.values(), key=lambda r: r["drugCode"]),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"saved {len(rows)} of {total} products -> {OUT}")


if __name__ == "__main__":
    asyncio.run(main())
