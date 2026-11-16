"""Download the raw inputs into data/raw/.

  python scripts/fetch_sources.py      NPPA notifications + brand table
  python scripts/fetch_pmbjp.py        Jan Aushadhi product list (needs Playwright)

Then: python scripts/build_data.py
"""
import hashlib
import pathlib
import urllib.request

RAW = pathlib.Path(__file__).resolve().parent.parent / "data" / "raw"
FILES = {
    # NPPA S.O. 1575(E), 25 Mar 2026: ceiling prices of 767 NLEM 2022 formulations, w.e.f. 1 Apr 2026
    "nppa_nlem2022_767_wpi_2026.pdf": "https://nppa.gov.in/storage/uploads/tender/0fd8be342c35d5a46a13b281cadc5e4f.pdf",
    # NPPA S.O. 1581(E): ceiling prices of 138 NLEM 2015 formulations, w.e.f. 1 Apr 2026
    "nppa_nlem2015_138_wpi_2026.pdf": "https://nppa.gov.in/storage/uploads/tender/0d883ca9b600c8a13cec452376176fc4.pdf",
    # Indian Medicine Dataset (MIT licence), brand -> composition
    "indian_medicine_data.csv": "https://raw.githubusercontent.com/junioralive/Indian-Medicine-Dataset/main/DATA/indian_medicine_data.csv",
}
EXPECTED = {
    "nppa_nlem2022_767_wpi_2026.pdf": "8c974127f5518cf2a31eb1a7ea69fefa4fbb161ea3a58823e9a5d2587bf7897c",
    "nppa_nlem2015_138_wpi_2026.pdf": "5447f882902216c4ea63d23916a70f3ecd71c1466d83369c0f7dee3dc6c81a4d",
    "indian_medicine_data.csv": "c9de0182474f652b7790a85bf534d0df9bd814575fcbda7109696d0fb3bec042",
}


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        dest = RAW / name
        if not dest.exists():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (bill-lens data build)"})
            with urllib.request.urlopen(req, timeout=300) as r:
                dest.write_bytes(r.read())
        h = hashlib.sha256(dest.read_bytes()).hexdigest()
        flag = "ok" if h == EXPECTED[name] else "CHANGED since 16 Nov 2026 (re-check the parser)"
        print(f"{name}: {dest.stat().st_size} bytes sha256 {h[:16]}... {flag}")


if __name__ == "__main__":
    main()
