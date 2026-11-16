// Image clean-up before OCR. Pure JS on RGBA pixel buffers so the exact same
// code runs in the browser (canvas ImageData) and in Node (evaluation).
//
// Steps: greyscale -> estimate the paper's uneven lighting with a large box
// blur -> divide it out (flat-field correction) -> percentile contrast stretch.
// Phone photos of bills usually have a shadow or a bright corner; Tesseract's
// global threshold copes badly with that, flat-fielding fixes most of it.

function boxBlur(src, w, h, r) {
  // separable running-sum blur, edge-clamped
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      const add = Math.min(w - 1, x + r + 1);
      const sub = Math.max(0, x - r);
      acc += src[row + add] - src[row + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      const add = Math.min(h - 1, y + r + 1);
      const sub = Math.max(0, y - r);
      acc += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}

function percentile(arr, p) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < arr.length; i++) hist[Math.max(0, Math.min(255, arr[i] | 0))]++;
  const target = arr.length * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/**
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} img RGBA
 * @returns {{data: Uint8ClampedArray, width: number, height: number}} RGBA greyscale, cleaned
 */
export function cleanForOcr(img) {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  // background estimate: blur of a dilated (max-filtered) image keeps text out of it
  const r1 = Math.max(2, Math.round(Math.min(w, h) / 200));
  const dil = maxFilter(g, w, h, r1);
  const bg = boxBlur(dil, w, h, Math.max(8, Math.round(Math.min(w, h) / 30)));
  const flat = new Float32Array(w * h);
  for (let i = 0; i < flat.length; i++) flat[i] = Math.min(255, (g[i] / Math.max(1, bg[i])) * 235);
  const lo = percentile(flat, 0.01);
  const hi = percentile(flat, 0.6);
  const span = Math.max(1, hi - lo);
  let grey = new Float32Array(w * h);
  for (let i = 0; i < flat.length; i++) {
    const v = ((flat[i] - lo) / span) * 255;
    grey[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  const angle = estimateSkew(grey, w, h);
  if (Math.abs(angle) > 0.15) grey = rotateGrey(grey, w, h, -angle);
  removeRules(grey, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = grey[i];
    out[j + 3] = 255;
  }
  return { data: out, width: w, height: h, skew: angle };
}

// Skew estimate by projection profiles: text rows give the sharpest
// row-histogram when the page is level. Works on a sample of dark pixels.
export function estimateSkew(grey, w, h, maxDeg = 7, step = 0.25) {
  const pts = [];
  const stride = Math.max(1, Math.round(Math.max(w, h) / 900));
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) if (grey[y * w + x] < 110) pts.push(x, y);
  if (pts.length < 200) return 0;
  let best = 0, bestScore = -1;
  const bins = Math.ceil(h / stride) + 200;
  const hist = new Float64Array(bins);
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += step) {
    const t = Math.tan((a * Math.PI) / 180);
    hist.fill(0);
    for (let i = 0; i < pts.length; i += 2) {
      const yy = Math.round((pts[i + 1] - pts[i] * t) / stride) + 100;
      if (yy >= 0 && yy < bins) hist[yy]++;
    }
    let s = 0;
    for (let i = 1; i < bins; i++) { const d = hist[i] - hist[i - 1]; s += d * d; }
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return best;
}

function rotateGrey(src, w, h, deg) {
  const out = new Float32Array(w * h).fill(255);
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // inverse map
      const dx = x - cx, dy = y - cy;
      const sx = c * dx + s * dy + cx, sy = -s * dx + c * dy + cy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0, fy = sy - y0;
      const i = y0 * w + x0;
      out[y * w + x] = src[i] * (1 - fx) * (1 - fy) + src[i + 1] * fx * (1 - fy) + src[i + w] * (1 - fx) * fy + src[i + w + 1] * fx * fy;
    }
  }
  return out;
}

// Erase long ruled lines (table borders, underlines). Tesseract reads
// bordered tables as noise; the text inside the cells survives this step.
export function removeRules(grey, w, h, thr = 200) {
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < dark.length; i++) dark[i] = grey[i] < thr ? 1 : 0;
  const clear = new Uint8Array(w * h);
  // horizontal: vertical dilation by 2 px, then long runs
  const minH = Math.round(w / 12);
  for (let y = 3; y < h - 3; y++) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      const on = x < w && (dark[(y - 3) * w + x] | dark[(y - 2) * w + x] | dark[(y - 1) * w + x] | dark[y * w + x] | dark[(y + 1) * w + x] | dark[(y + 2) * w + x] | dark[(y + 3) * w + x]);
      if (on) run++;
      else {
        if (run >= minH) for (let k = x - run; k < x; k++) clear[y * w + k] = 1;
        run = 0;
      }
    }
  }
  const minV = Math.round(h / 18);
  for (let x = 3; x < w - 3; x++) {
    let run = 0;
    for (let y = 0; y <= h; y++) {
      const i = y * w + x;
      const on = y < h && (dark[i - 3] | dark[i - 2] | dark[i - 1] | dark[i] | dark[i + 1] | dark[i + 2] | dark[i + 3]);
      if (on) run++;
      else {
        if (run >= minV) for (let k = y - run; k < y; k++) clear[k * w + x] = 1;
        run = 0;
      }
    }
  }
  for (let i = 0; i < grey.length; i++) if (clear[i]) grey[i] = 255;
}

function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let k = a; k <= b; k++) if (src[row + k] > m) m = src[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let k = a; k <= b; k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Downscale so the longer side is at most maxSide (nearest-neighbour is not enough; use area average). */
export function limitSize(img, maxSide = 2000) {
  const { width: w, height: h } = img;
  const s = Math.min(1, maxSide / Math.max(w, h));
  if (s >= 1) return img;
  const nw = Math.round(w * s), nh = Math.round(h * s);
  const out = new Uint8ClampedArray(nw * nh * 4);
  const inv = 1 / s;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * inv), y1 = Math.min(h, Math.floor((y + 1) * inv));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * inv), x1 = Math.min(w, Math.floor((x + 1) * inv));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const j = (yy * w + xx) * 4; r += img.data[j]; g += img.data[j + 1]; b += img.data[j + 2]; n++;
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}
