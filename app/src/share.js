// Summary card (PNG) and plain-text summary for sharing with family.

const fmt = (v, d = 2) => Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

export function shareText(state, t) {
  const s = state.summary || {};
  const lines = [`${t("appName")}: ${t("youPaid")} ₹${fmt(s.total)}`];
  if (s.flagged) lines.push(`${t("possibleOver")}: ₹${fmt(s.overcharge)} (${t("onLines", s.flagged)})`);
  else lines.push(t("noOver"));
  if (s.savings > 0.5) lines.push(`${t("couldSave")}: ₹${fmt(s.savings, 0)}`);
  for (const l of state.lines || []) {
    if (!l.match) continue;
    const bits = [];
    if (l.check.flags.length) bits.push(t("possibleOver"));
    if (l.check.savings > 0.5) bits.push(`Jan Aushadhi ₹${fmt(l.check.savings, 0)}`);
    if (bits.length) lines.push(`• ${l.match.label || l.item.name}: ${bits.join(", ")}`);
  }
  lines.push(t("switchNote"));
  return lines.join("\n");
}

export async function renderShareCard(state, t) {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const s = state.summary || {};
  const font = (w, px, serif) => `${w} ${px}px ${serif ? '"Iowan Old Style", "Noto Serif", Georgia, serif' : 'system-ui, "Noto Sans", "Noto Sans Devanagari", sans-serif'}`;
  g.fillStyle = "#F4F1EA"; g.fillRect(0, 0, W, H);
  // paper slip
  g.fillStyle = "#FFFDF8";
  g.fillRect(70, 70, W - 140, H - 140);
  g.fillStyle = "#F4F1EA";
  for (let x = 70; x < W - 70; x += 36) { g.beginPath(); g.arc(x + 18, 70, 10, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = "#1D2528";
  g.font = font(600, 44, true);
  g.fillText(t("appName"), 130, 175);
  g.font = font(400, 30);
  g.fillStyle = "#4A5558";
  g.fillText(t("youPaid"), 130, 260);
  g.fillStyle = "#1D2528";
  g.font = font(700, 96);
  g.fillText(`₹${fmt(s.total)}`, 130, 360);
  let y = 470;
  const block = (label, value, color, sub) => {
    g.fillStyle = color; g.fillRect(130, y - 40, 8, 120);
    g.fillStyle = "#4A5558"; g.font = font(400, 30); g.fillText(label, 165, y);
    g.fillStyle = color; g.font = font(700, 64); g.fillText(value, 165, y + 70);
    if (sub) { g.fillStyle = "#4A5558"; g.font = font(400, 28); g.fillText(sub, 165 + g.measureText(value).width + 30, y + 70); }
    y += 175;
  };
  if (s.flagged) block(t("possibleOver"), `₹${fmt(s.overcharge)}`, "#A8432A", t("onLines", s.flagged));
  else { g.fillStyle = "#0E6655"; g.font = font(600, 36); g.fillText(t("noOver").slice(0, 52), 130, y); y += 120; }
  if (s.savings > 0.5) block(t("couldSave"), `₹${fmt(s.savings, 0)}`, "#0E6655");
  g.font = font(400, 28);
  for (const l of (state.lines || []).slice(0, 6)) {
    if (!l.match) continue;
    const tag = l.check.flags.length ? "!" : "✓";
    g.fillStyle = l.check.flags.length ? "#A8432A" : "#0E6655";
    g.fillText(tag, 130, y);
    g.fillStyle = "#1D2528";
    const name = (l.match.label || l.item.name).slice(0, 34);
    g.fillText(name, 170, y);
    g.textAlign = "right";
    g.fillText(`₹${fmt(l.item.amount)}`, W - 130, y);
    g.textAlign = "left";
    y += 48;
  }
  g.fillStyle = "#4A5558";
  g.font = font(400, 24);
  wrap(g, t("switchNote"), 130, H - 210, W - 260, 32);
  g.fillText("NPPA ceiling prices w.e.f. 1 Apr 2026 · Jan Aushadhi list Nov 2026", 130, H - 110);
  return new Promise((res) => c.toBlob(res, "image/png"));
}

function wrap(g, text, x, y, maxW, lh) {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (g.measureText(test).width > maxW && line) { g.fillText(line, x, y); line = w; y += lh; }
    else line = test;
  }
  if (line) g.fillText(line, x, y);
}
