// Flatten Tesseract.js block output into a simple list of text lines with word boxes.

export function flattenBlocks(page) {
  const lines = [];
  for (const block of page.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || [])
          .map((w) => ({ text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }))
          .filter((w) => w.text && w.text.trim());
        if (!words.length) continue;
        lines.push({
          text: words.map((w) => w.text).join(" "),
          conf: line.confidence,
          x0: line.bbox.x0, y0: line.bbox.y0, x1: line.bbox.x1, y1: line.bbox.y1,
          words,
        });
      }
    }
  }
  return regroupRows(lines);
}

// Tesseract sometimes splits one printed row into several "lines" (one per
// column block) when columns are far apart. Merge lines whose vertical centres
// overlap strongly, then sort top-to-bottom.
export function regroupRows(lines) {
  const sorted = [...lines].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const rows = [];
  for (const ln of sorted) {
    const cy = (ln.y0 + ln.y1) / 2;
    const hgt = ln.y1 - ln.y0;
    let target = null;
    for (const r of rows.slice(-3)) {
      const rc = (r.y0 + r.y1) / 2;
      const rh = r.y1 - r.y0;
      const overlap = Math.min(r.y1, ln.y1) - Math.max(r.y0, ln.y0);
      const noXOverlap = ln.x0 > r.x1 - 5 || ln.x1 < r.x0 + 5;
      if (noXOverlap && overlap > 0.5 * Math.min(hgt, rh) && Math.abs(rc - cy) < 0.6 * Math.max(hgt, rh)) {
        target = r;
        break;
      }
    }
    if (target) {
      target.words = [...target.words, ...ln.words].sort((a, b) => a.x0 - b.x0);
      target.text = target.words.map((w) => w.text).join(" ");
      target.x0 = Math.min(target.x0, ln.x0); target.x1 = Math.max(target.x1, ln.x1);
      target.y0 = Math.min(target.y0, ln.y0); target.y1 = Math.max(target.y1, ln.y1);
      target.conf = Math.min(target.conf, ln.conf);
    } else {
      rows.push({ ...ln, words: [...ln.words].sort((a, b) => a.x0 - b.x0) });
    }
  }
  return rows;
}
