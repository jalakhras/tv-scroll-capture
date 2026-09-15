import { putResult } from './idb.js';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const DEFAULTS = {
  direction: 'left',    // left = back in history, right = toward realtime
  steps: 20,
  stepPct: 50,          // % of pane width per horizontal step
  settleMs: 450,
  intervalMs: 250,      // manual sampling interval
  hideOverlays: true,
  includeAxis: true,
  verticalTrack: true,  // follow candles that leave the pane vertically
  maxVert: 6,           // max vertical moves after each horizontal step
  autoScaleOff: true,   // nudge the chart vertically first: TradingView turns Auto Scale off
};
const MAX_SIDE = 32000;           // final image side limit
const MAX_AREA = 200_000_000;     // final image pixel limit
const CANVAS_SIDE = 32767, CANVAS_AREA = 268_000_000; // Chrome hard limits
// normalised mismatch (0 = identical); true matches score ~0.01-0.03
const THRESH = { auto: { warn: 0.06, reject: 0.15 }, manual: { warn: 0.12, reject: 0.3 } };
const COV_SIZE = 140000, COV_OFF = 70000;

const state = {
  running: false, mode: null, tabId: null, stop: false, detached: false,
  status: 'جاهز', frames: 0, widthPx: 0, heightPx: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
const exec = async (tabId, func, args = []) =>
  (await chrome.scripting.executeScript({ target: { tabId }, func, args }))[0]?.result;
const badge = (text) => chrome.action.setBadgeText({ text }).catch(() => {});

async function getOpts(overrides) {
  const { opts } = await chrome.storage.local.get('opts');
  return { ...DEFAULTS, ...(opts || {}), ...(overrides || {}) };
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getState') {
    const { running, mode, status, frames, widthPx, heightPx } = state;
    sendResponse({ running, mode, status, frames, widthPx, heightPx });
  } else if (msg.type === 'start') {
    if (state.running) sendResponse({ ok: false, error: 'يوجد التقاط قيد التشغيل' });
    else { run(msg.mode, msg.tabId, msg.opts); sendResponse({ ok: true }); }
  } else if (msg.type === 'stop') {
    state.stop = true;
    sendResponse({ ok: true });
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-capture') return;
  if (state.running) { state.stop = true; return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /tradingview\.com/.test(tab.url || '')) run('manual', tab.id, await getOpts());
});

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId === state.tabId) { state.detached = true; state.stop = true; }
});

/* ------------------------------------------------------------------ */
/* Functions injected into the TradingView page                        */
/* ------------------------------------------------------------------ */
function pageDetectLayout() {
  const items = [...document.querySelectorAll('canvas')]
    .map((c) => ({ c, r: c.getBoundingClientRect() }))
    .filter((o) => o.r.width > 40 && o.r.height > 12 &&
      getComputedStyle(o.c).visibility !== 'hidden' &&
      o.r.right > 0 && o.r.bottom > 0 && o.r.left < innerWidth && o.r.top < innerHeight);
  if (!items.length) return null;

  // Main price pane = largest canvas
  const pane = items.reduce((a, b) => (a.r.width * a.r.height >= b.r.width * b.r.height ? a : b));
  const L = pane.r.left, W = pane.r.width;

  // Indicator panes + time axis below the main pane share its x range
  const column = items.filter((o) => Math.abs(o.r.left - L) <= 3 && Math.abs(o.r.width - W) <= 3 &&
    o.r.top >= pane.r.bottom - 8);
  let bottom = pane.r.bottom, changed = true;
  while (changed) {
    changed = false;
    for (const o of column) {
      if (o.r.top <= bottom + 8 && o.r.bottom > bottom) { bottom = o.r.bottom; changed = true; }
    }
  }

  const x0 = Math.max(0, L), y0 = Math.max(0, pane.r.top);
  const x1 = Math.min(innerWidth, pane.r.right), y1 = Math.min(innerHeight, pane.r.bottom);
  bottom = Math.min(innerHeight, bottom);

  // Price axis = canvases just right of the pane column
  const axes = items.filter((o) => o.r.left >= L + W - 2 && o.r.left <= L + W + 20 &&
    o.r.top >= pane.r.top - 8 && o.r.bottom <= bottom + 8 && o.r.width < W / 2);
  let axis = null;
  if (axes.length) {
    const ax0 = Math.min(...axes.map((o) => o.r.left));
    const ax1 = Math.min(innerWidth, Math.max(...axes.map((o) => o.r.right)));
    if (ax1 - ax0 > 4) axis = { x: ax0, w: ax1 - ax0 };
  }

  return {
    scrollX, scrollY,
    pane: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    bottom,
    axis,
  };
}

function pageHideOverlays(region) {
  const list = (window.__tvscHidden = window.__tvscHidden || []);
  const x1 = region.x - 1, y1 = region.y - 1;
  const x2 = region.x + region.w + 1, y2 = region.y + region.h + 1;
  const maxArea = region.w * region.h * 0.4; // never hide full-pane layers
  for (const el of document.body.querySelectorAll('*')) {
    if (el.tagName === 'CANVAS' || el.hasAttribute('data-tvsc-hidden')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.left < x1 || r.right > x2 || r.top < y1 || r.bottom > y2) continue;
    if (r.width * r.height > maxArea) continue;
    if (el.querySelector('canvas')) continue;
    el.setAttribute('data-tvsc-hidden', '1');
    el.style.setProperty('visibility', 'hidden', 'important');
    list.push(el);
  }
  return list.length;
}

function pageRestore() {
  for (const el of window.__tvscHidden || []) {
    el.style.removeProperty('visibility');
    el.removeAttribute('data-tvsc-hidden');
  }
  window.__tvscHidden = [];
}

/* ------------------------------------------------------------------ */
/* Image helpers                                                       */
/* ------------------------------------------------------------------ */
async function b64ToBitmap(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([u], { type: 'image/png' }));
}

function toGray({ data, width, height }) {
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return g;
}

function bitmapGray(bmp) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return toGray(ctx.getImageData(0, 0, bmp.width, bmp.height));
}

function downsample(g, w, h, f) {
  const W = Math.max(1, Math.floor(w / f)), H = Math.max(1, Math.floor(h / f)), n = f * f;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) {
        const row = (y * f + yy) * w + x * f;
        for (let xx = 0; xx < f; xx++) s += g[row + xx] || 0;
      }
      out[y * W + x] = s / n;
    }
  }
  return { g: out, w: W, h: H };
}

function modeGray(g) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  let best = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[best]) best = v;
  return best;
}

function findRGB(img, g, value) {
  for (let j = 0; j < g.length; j++) {
    if (g[j] === value) return [img.data[j * 4], img.data[j * 4 + 1], img.data[j * 4 + 2]];
  }
  return [19, 23, 34];
}

/* ------------------------------------------------------------------ */
/* 2D matching                                                         */
/* content of `a` at (x, y) appears in `b` at (x + dx, y + dy)          */
/* ------------------------------------------------------------------ */
function sad2(A, B, dx, dy, step) {
  const w = A.w, h = A.h, a = A.g, b = B.g, bga = A.bg, bgb = B.bg, T = A.T;
  const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
  if (x1 - x0 < w * 0.2 || y1 - y0 < h * 0.3) return Infinity;
  // Compare "ink" masks (candles, text): weak pixels such as grid lines and
  // background are ignored, so empty or grid-only overlaps cannot match.
  let uni = 0, bad = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    const ra = y * w, rb = (y + dy) * w + dx;
    for (let x = x0; x < x1; x += step) {
      const va = a[ra + x], vb = b[rb + x];
      const sa = (va > bga ? va - bga : bga - va) > T;
      const sb = (vb > bgb ? vb - bgb : bgb - vb) > T;
      n++;
      if (sa || sb) {
        uni++;
        if (!(sa && sb) || (va > vb ? va - vb : vb - va) > T) bad++;
      }
    }
  }
  if (uni < Math.max(12, n * 0.002)) return 1;
  const frac = ((x1 - x0) * (y1 - y0)) / (w * h);
  return bad / uni + 0.03 * (1 - frac);
}

function grid(A, B, dxLo, dxHi, dyLo, dyHi, step, keep) {
  const best = [];
  for (let dy = dyLo; dy <= dyHi; dy++) {
    for (let dx = dxLo; dx <= dxHi; dx++) {
      const e = sad2(A, B, dx, dy, step);
      if (!Number.isFinite(e)) continue;
      if (best.length < keep || e < best[best.length - 1].e) {
        best.push({ dx, dy, e });
        best.sort((p, q) => p.e - q.e);
        if (best.length > keep) best.pop();
      }
    }
  }
  return best;
}

/* Phase correlation (FFT) for wide, unknown shifts --------------------- */
function fft1(re, im, n, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? -2 : 2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

function fft2(re, im, W, H, inverse) {
  const tr = new Float64Array(Math.max(W, H)), ti = new Float64Array(Math.max(W, H));
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) { tr[x] = re[o + x]; ti[x] = im[o + x]; }
    fft1(tr, ti, W, inverse);
    for (let x = 0; x < W; x++) { re[o + x] = tr[x]; im[o + x] = ti[x]; }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) { tr[y] = re[y * W + x]; ti[y] = im[y * W + x]; }
    fft1(tr, ti, H, inverse);
    for (let y = 0; y < H; y++) { re[y * W + x] = tr[y]; im[y * W + x] = ti[y]; }
  }
}

function spectrum(f) {
  if (f.spec) return f.spec;
  const L = f.s4, W = 1 << Math.ceil(Math.log2(L.w)), H = 1 << Math.ceil(Math.log2(L.h));
  const re = new Float64Array(W * H), im = new Float64Array(W * H);
  for (let y = 0; y < L.h; y++) {
    for (let x = 0; x < L.w; x++) {
      const v = L.g[y * L.w + x], d = v > L.bg ? v - L.bg : L.bg - v;
      re[y * W + x] = d > L.T ? d : 0; // ink only: background and grid become 0
    }
  }
  fft2(re, im, W, H, false);
  return (f.spec = { re, im, W, H });
}

function findShiftWide(p, c, r) {
  const A = spectrum(p), B = spectrum(c), { W, H } = A, N = W * H;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const cr = A.re[i] * B.re[i] + A.im[i] * B.im[i];
    const ci = A.im[i] * B.re[i] - A.re[i] * B.im[i];
    const m = Math.hypot(cr, ci) + 1e-9;
    re[i] = cr / m; im[i] = ci / m;
  }
  fft2(re, im, W, H, true);

  // strongest peaks with simple suppression
  const peaks = [];
  for (let t = 0; t < 8; t++) {
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < N; i++) {
      if (re[i] <= bv) continue;
      const x = i % W, y = (i / W) | 0;
      if (peaks.some((q) => Math.min(Math.abs(q.x - x), W - Math.abs(q.x - x)) < 3 &&
                             Math.min(Math.abs(q.y - y), H - Math.abs(q.y - y)) < 3)) continue;
      bv = re[i]; bi = i;
    }
    if (bi < 0) break;
    peaks.push({ x: bi % W, y: (bi / W) | 0 });
  }

  const lo = { x: Math.floor(r.dxLo / 4), y: Math.floor(r.dyLo / 4) };
  const hi = { x: Math.ceil(r.dxHi / 4), y: Math.ceil(r.dyHi / 4) };
  let best = null;
  const tried = new Set();
  for (const pk of peaks) {
    for (const bx of [pk.x, pk.x - W]) for (const by of [pk.y, pk.y - H]) for (const sgn of [1, -1]) {
      const dx = sgn * bx, dy = sgn * by, key = dx + ',' + dy;
      if (tried.has(key) || dx < lo.x || dx > hi.x || dy < lo.y || dy > hi.y) continue;
      tried.add(key);
      const g = grid(p.s4, c.s4, dx - 1, dx + 1, dy - 1, dy + 1, 1, 1)[0];
      if (g && (!best || g.e < best.e)) best = g;
    }
  }
  return best;
}

function findShift2D(p, c, r) {
  const n4 = ((r.dxHi - r.dxLo) / 4 + 1) * ((r.dyHi - r.dyLo) / 4 + 1);
  const seed = n4 <= 4000
    ? grid(p.s4, c.s4, Math.floor(r.dxLo / 4), Math.ceil(r.dxHi / 4),
        Math.floor(r.dyLo / 4), Math.ceil(r.dyHi / 4), 1, 1)[0]
    : findShiftWide(p, c, r);
  if (!seed) return { dx: 0, dy: 0, err: Infinity };
  const f = grid(p, c, seed.dx * 4 - 5, seed.dx * 4 + 5, seed.dy * 4 - 5, seed.dy * 4 + 5, 2, 1)[0];
  return f ? { dx: f.dx, dy: f.dy, err: f.e } : { dx: 0, dy: 0, err: Infinity };
}

function axisChanged(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 40) changed++;
  return changed / a.length > 0.03;
}

/* ------------------------------------------------------------------ */
/* Clipped-candle detection                                            */
/* A column counts when ink fills the edge band but not the whole       */
/* pane height (that would be a vertical grid line), and nothing above  */
/* or below that column has been captured yet.                          */
/* ------------------------------------------------------------------ */
function clipInfo(f, st) {
  const { g, w, h, bg, k } = f;
  const band = Math.max(3, Math.round(3 * k)), T = 40;
  let top = 0, bottom = 0;
  for (let x = 0; x < w; x++) {
    let t = 0, b = 0;
    for (let y = 0; y < band; y++) {
      if (Math.abs(g[y * w + x] - bg) > T) t++;
      if (Math.abs(g[(h - 1 - y) * w + x] - bg) > T) b++;
    }
    const tHit = t >= band * 0.7, bHit = b >= band * 0.7;
    if (!tHit && !bHit) continue;
    let full = 0, n = 0;
    for (let y = 0; y < h; y += 4) { n++; if (Math.abs(g[y * w + x] - bg) > T) full++; }
    if (full / n >= 0.9) continue;
    const gi = st.X + x + COV_OFF;
    if (gi < 0 || gi >= COV_SIZE) continue;
    if (tHit && st.covTop[gi] >= st.Y) top++;
    if (bHit && st.covBot[gi] <= st.Y + h) bottom++;
  }
  const need = Math.max(2, Math.round(k));
  return { top: top >= need, bottom: bottom >= need };
}

/* ------------------------------------------------------------------ */
/* Growable canvas (expands in any direction)                          */
/* ------------------------------------------------------------------ */
class Grow {
  constructor() { this.c = null; this.ox = 0; this.oy = 0; this.b = null; }

  ensure(x0, y0, x1, y1) {
    const b = this.b
      ? { x0: Math.min(this.b.x0, x0), y0: Math.min(this.b.y0, y0), x1: Math.max(this.b.x1, x1), y1: Math.max(this.b.y1, y1) }
      : { x0, y0, x1, y1 };
    this.b = b;
    if (this.c && b.x0 >= this.ox && b.y0 >= this.oy &&
        b.x1 <= this.ox + this.c.width && b.y1 <= this.oy + this.c.height) return;

    let nx0 = b.x0, ny0 = b.y0, nx1 = b.x1, ny1 = b.y1;
    if (this.c) {
      const mx = (x1 - x0) * 2, my = y1 - y0; // headroom to avoid reallocating every frame
      if (b.x0 < this.ox) nx0 -= mx;
      if (b.x1 > this.ox + this.c.width) nx1 += mx;
      if (b.y0 < this.oy) ny0 -= my;
      if (b.y1 > this.oy + this.c.height) ny1 += my;
      nx0 = Math.min(nx0, this.ox); ny0 = Math.min(ny0, this.oy);
      nx1 = Math.max(nx1, this.ox + this.c.width); ny1 = Math.max(ny1, this.oy + this.c.height);
    }
    let cw = nx1 - nx0, ch = ny1 - ny0;
    if (cw > CANVAS_SIDE || ch > CANVAS_SIDE || cw * ch > CANVAS_AREA) {
      nx0 = b.x0; ny0 = b.y0; cw = b.x1 - b.x0; ch = b.y1 - b.y0;
    }
    const nc = new OffscreenCanvas(cw, ch);
    if (this.c) {
      nc.getContext('2d').drawImage(this.c, this.ox - nx0, this.oy - ny0);
      this.c.width = 0; this.c.height = 0;
    }
    this.c = nc; this.ox = nx0; this.oy = ny0;
  }

  // destination-over: pixels captured first win; only empty areas get filled
  draw(bmp, X, Y) {
    this.ensure(X, Y, X + bmp.width, Y + bmp.height);
    const ctx = this.c.getContext('2d');
    ctx.globalCompositeOperation = 'destination-over';
    ctx.drawImage(bmp, X - this.ox, Y - this.oy);
    ctx.globalCompositeOperation = 'source-over';
  }

  free() { if (this.c) { this.c.width = 0; this.c.height = 0; this.c = null; } }
}

/* ------------------------------------------------------------------ */
/* Capture & stitching                                                 */
/* ------------------------------------------------------------------ */
async function grab(tabId, L) {
  const P = L.pane;
  const boxW = (L.axis ? L.axis.x + L.axis.w : P.x + P.w) - P.x;
  const boxH = L.bottom - P.y;
  const shot = await cdp(tabId, 'Page.captureScreenshot', {
    format: 'png', fromSurface: true,
    clip: { x: P.x + L.scrollX, y: P.y + L.scrollY, width: boxW, height: boxH, scale: 1 },
  });
  const bmp = await b64ToBitmap(shot.data);
  const k = bmp.width / boxW; // image px per CSS px
  const w = Math.min(bmp.width, Math.round(P.w * k));
  const h = Math.min(bmp.height, Math.round(P.h * k));

  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const g = toGray(img);
  const s4 = downsample(g, w, h, 4);
  const bg = modeGray(s4.g);
  s4.bg = bg; s4.T = 40; // high enough to ignore faint watermarks and grid

  const f = {
    bmp: c.transferToImageBitmap(), g, w, h, k, s4, spec: null,
    bg, T: 40, bgRGB: findRGB(img, g, bg), axis: null, axisG: null, lower: null,
  };
  if (L.axis) {
    const ax = Math.round((L.axis.x - P.x) * k), aw = bmp.width - ax;
    if (aw > 0) { f.axis = await createImageBitmap(bmp, ax, 0, aw, h); f.axisG = bitmapGray(f.axis); }
  }
  if (bmp.height - h > 2) f.lower = await createImageBitmap(bmp, 0, h, w, bmp.height - h);
  bmp.close();
  return f;
}

function closeFrame(f) {
  if (!f) return;
  f.bmp?.close(); f.axis?.close(); f.lower?.close();
  f.bmp = f.axis = f.lower = null;
}

function makeStitcher() {
  return {
    main: new Grow(), axis: new Grow(), lower: new Grow(),
    X: 0, Y: 0, frames: 0, bgRGB: null,
    covTop: new Float64Array(COV_SIZE).fill(Infinity),
    covBot: new Float64Array(COV_SIZE).fill(-Infinity),
  };
}

function wouldFit(st, f, X, Y) {
  const b = st.main.b;
  const x0 = Math.min(b.x0, X), x1 = Math.max(b.x1, X + f.w);
  const y0 = Math.min(b.y0, Y), y1 = Math.max(b.y1, Y + f.h);
  const W = x1 - x0 + (f.axis ? f.axis.width : 0);
  const H = y1 - y0 + (f.lower ? f.lower.height : 0);
  return W <= MAX_SIDE && H <= MAX_SIDE && W * H <= MAX_AREA &&
    X + COV_OFF >= 0 && X + f.w + COV_OFF < COV_SIZE;
}

// Places frame f whose content moved by (dx, dy) relative to the previous accepted frame
function accept(st, f, dx, dy) {
  const X = st.X - dx, Y = st.Y - dy;
  if (st.frames && !wouldFit(st, f, X, Y)) return false;
  st.main.draw(f.bmp, X, Y);
  if (f.axis) st.axis.draw(f.axis, 0, Y);
  if (f.lower) st.lower.draw(f.lower, X, 0);
  for (let x = 0; x < f.w; x++) {
    const i = X + x + COV_OFF;
    if (Y < st.covTop[i]) st.covTop[i] = Y;
    if (Y + f.h > st.covBot[i]) st.covBot[i] = Y + f.h;
  }
  st.X = X; st.Y = Y; st.frames++;
  if (!st.bgRGB) st.bgRGB = f.bgRGB;
  closeFrame(f); // pixels are now in the canvases; grey data stays for matching
  return true;
}

async function compose(st, includeAxis) {
  const b = st.main.b, W = b.x1 - b.x0, Hm = b.y1 - b.y0;
  const aw = includeAxis && st.axis.b ? st.axis.b.x1 - st.axis.b.x0 : 0;
  const hl = st.lower.b ? st.lower.b.y1 - st.lower.b.y0 : 0;
  const out = new OffscreenCanvas(W + aw, Hm + hl);
  const ctx = out.getContext('2d');
  const [r, g, bl] = st.bgRGB || [19, 23, 34];
  ctx.fillStyle = `rgb(${r},${g},${bl})`;
  ctx.fillRect(0, 0, W + aw, Hm + hl);
  ctx.drawImage(st.main.c, b.x0 - st.main.ox, b.y0 - st.main.oy, W, Hm, 0, 0, W, Hm);
  if (aw) ctx.drawImage(st.axis.c, st.axis.b.x0 - st.axis.ox, b.y0 - st.axis.oy, aw, Hm, W, 0, aw, Hm);
  if (hl) ctx.drawImage(st.lower.c, b.x0 - st.lower.ox, st.lower.b.y0 - st.lower.oy, W, hl, 0, Hm, W, hl);
  return { blob: await out.convertToBlob({ type: 'image/png' }), width: W + aw, height: Hm + hl };
}

// Start drags on empty background so drawings and indicator shapes are never grabbed
function pickStart(f, L, dxCss, dyCss) {
  const P = L.pane, k = f.k, half = Math.round(10 * k), m = 20;
  const fr = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];
  for (const fy of fr) {
    for (const fx of fr) {
      const sx = P.x + P.w * fx - dxCss / 2, sy = P.y + P.h * fy - dyCss / 2;
      const ex = sx + dxCss, ey = sy + dyCss;
      if (Math.min(sx, ex) < P.x + m || Math.max(sx, ex) > P.x + P.w - m) continue;
      if (Math.min(sy, ey) < P.y + m || Math.max(sy, ey) > P.y + P.h - m) continue;
      const ix = Math.round((sx - P.x) * k), iy = Math.round((sy - P.y) * k);
      let empty = true;
      for (let y = iy - half; y <= iy + half && empty; y++) {
        if (y < 0 || y >= f.h) { empty = false; break; }
        for (let x = ix - half; x <= ix + half; x++) {
          if (x < 0 || x >= f.w || Math.abs(f.g[y * f.w + x] - f.bg) > 25) { empty = false; break; }
        }
      }
      if (empty) return { x: Math.round(sx), y: Math.round(sy) };
    }
  }
  return null;
}

async function drag(tabId, L, dxCss, dyCss, start) {
  const P = L.pane, moves = 14;
  const x0 = start ? start.x : Math.round(P.x + P.w / 2 - dxCss / 2);
  const y0 = start ? start.y : Math.round(P.y + P.h / 2 - dyCss / 2);
  const ev = (type, x, y, extra = {}) => cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, ...extra });
  await ev('mouseMoved', x0, y0);
  await ev('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 });
  for (let s = 1; s <= moves; s++) {
    await ev('mouseMoved', Math.round(x0 + (dxCss * s) / moves), Math.round(y0 + (dyCss * s) / moves), { button: 'left', buttons: 1 });
    await sleep(12);
  }
  await sleep(60); // let velocity drop to zero before release
  await ev('mouseReleased', x0 + dxCss, y0 + dyCss, { button: 'left', buttons: 0, clickCount: 1 });
}

/* ------------------------------------------------------------------ */
/* Main run                                                            */
/* ------------------------------------------------------------------ */
async function run(mode, tabId, overrides) {
  const opts = await getOpts(overrides);
  await chrome.storage.local.set({ opts });
  Object.assign(state, { running: true, mode, tabId, stop: false, detached: false, frames: 0, widthPx: 0, heightPx: 0 });
  badge('REC');

  const WARN_ERR = THRESH[mode].warn, REJECT_ERR = THRESH[mode].reject;
  const warnings = [];
  const seen = new Set();
  const warn = (key, msg) => { if (key) { if (seen.has(key)) return; seen.add(key); } warnings.push(msg); };

  let attached = false, st = null, prev = null;
  const progress = () => {
    const b = st.main.b;
    state.frames = st.frames; state.widthPx = b.x1 - b.x0; state.heightPx = b.y1 - b.y0;
  };

  try {
    state.status = 'تحليل تخطيط الشارت…';
    const L = await exec(tabId, pageDetectLayout);
    if (!L || L.pane.w < 100 || L.pane.h < 60) throw new Error('لم يتم العثور على منطقة الشارت في الصفحة');

    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;

    const P = L.pane;
    const hideRect = { x: P.x, y: P.y, w: P.w, h: L.bottom - P.y };
    const parkMouse = () => cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    const prep = async () => { if (opts.hideOverlays) await exec(tabId, pageHideOverlays, [hideRect]); };
    const settle = async () => { await parkMouse(); await sleep(opts.settleMs); await prep(); await sleep(80); };
    let screen = null; // latest grabbed frame, used to find empty spots to drag from
    const grabS = async () => (screen = await grab(tabId, L));
    const move = async (dx, dy) => {
      const start = screen ? pickStart(screen, L, dx, dy) : null;
      if (!start) warn('nostart', 'لم أجد مساحة فارغة لبدء السحب، فاستُخدم منتصف الشارت. إن تحرّكت رسمة بدل الشارت فأخفِ الرسومات.');
      await drag(tabId, L, dx, dy, start);
    };

    if (mode === 'auto') { await parkMouse(); await sleep(150); }
    await prep();
    await sleep(120);

    if (opts.autoScaleOff) {
      // A vertical pan makes TradingView switch Auto Scale off; pan back to the same place
      state.status = 'إيقاف Auto Scale…';
      const probe = await grabS();
      await move(0, 40);
      await sleep(250);
      await move(0, -40);
      closeFrame(probe);
      await settle();
    }

    st = makeStitcher();
    prev = await grabS();
    accept(st, prev, 0, 0);
    progress();

    const k = prev.k;
    const tol = Math.round(8 * k);

    const tryAccept = (cur, m) => {
      if (!accept(st, cur, m.dx, m.dy)) {
        warn('cap', 'بلغت الصورة الحد الأقصى للحجم الذي يسمح به Chrome، تم الإيقاف عند هذه النقطة.');
        closeFrame(cur);
        return false;
      }
      prev = cur;
      progress();
      return true;
    };

    // Reveal candles cut at the top/bottom edge. Returns false if the size cap was hit.
    const trackVertical = async () => {
      if (!opts.verticalTrack) return true;
      for (let v = 0; v < opts.maxVert && !state.stop; v++) {
        const clip = clipInfo(prev, st);
        if (!clip.top && !clip.bottom) return true;
        if (clip.top && clip.bottom) {
          warn('tall', 'بعض الشموع أو الحركات أطول من ارتفاع اللوحة في لقطة واحدة. صغّر المقياس السعري قليلاً إن ظهرت فجوات.');
          return true;
        }
        const dyCss = (clip.top ? 1 : -1) * Math.round(P.h * 0.4);
        state.status = `تتبّع عمودي ${clip.top ? '↑' : '↓'}…`;
        await move(0, dyCss);
        await settle();

        const cur = await grabS();
        const exp = dyCss * k, span = Math.abs(exp) * 0.5 + 20 * k;
        const m = findShift2D(prev, cur, { dxLo: -tol, dxHi: tol, dyLo: Math.round(exp - span), dyHi: Math.round(exp + span) });
        if (m.err > REJECT_ERR) {
          warn(null, `تتبّع عمودي: تطابق ضعيف (${Math.round(m.err * 100)}%)، تم تجاهل هذه اللقطة وإرجاع الشارت لمكانه.`);
          closeFrame(cur);
          await move(0, -dyCss); // restore position so the next horizontal match still lines up
          await settle();
          return true;
        }
        if (Math.abs(m.dy) < Math.abs(exp) * 0.2) { closeFrame(cur); return true; }
        if (!tryAccept(cur, m)) return false;
      }
      const clip = clipInfo(prev, st);
      if (clip.top || clip.bottom) {
        warn('maxvert', 'بلغ التتبّع العمودي حدّه في بعض المواضع. زد "أقصى تحريكات عمودية" أو صغّر المقياس السعري.');
      }
      return true;
    };

    if (mode === 'auto') {
      let ok = await trackVertical();
      const dir = opts.direction === 'left' ? 1 : -1; // drag right = older bars
      const pct = Math.min(80, Math.max(10, Number(opts.stepPct) || 50));
      const stepCss = Math.max(40, Math.round((P.w * pct) / 100));
      const exp = dir * stepCss * k;
      const span = Math.abs(exp) * 0.5 + 20 * k;
      let stalls = 0, scaleChecked = false;

      for (let i = 1; i <= opts.steps && ok && !state.stop; i++) {
        state.status = `خطوة ${i} من ${opts.steps}…`;
        await move(dir * stepCss, 0);
        await settle();

        const cur = await grabS();
        const m = findShift2D(prev, cur, { dxLo: Math.round(exp - span), dxHi: Math.round(exp + span), dyLo: -tol, dyHi: tol });

        if (!scaleChecked) {
          scaleChecked = true;
          if (Math.abs(m.dy) <= 1 && axisChanged(prev.axisG, cur.axisG)) {
            if (m.err > WARN_ERR) {
              warn('scale', 'المقياس السعري تغيّر مع الحركة الأفقية، فتم الإيقاف لتجنّب دمج خاطئ. تأكد أن زر A مطفأ، وأن خيار Lock price to bar ratio غير مفعّل.');
              closeFrame(cur);
              break;
            }
            warn('scale-soft', 'محور السعر تغيّر قليلاً بعد أول تحريك، لكن الشموع تطابقت. راجع الصورة للتأكد.');
          }
        }
        if (m.err > REJECT_ERR) {
          warn(null, `خطوة ${i}: تطابق ضعيف (${Math.round(m.err * 100)}%)، تم إيقاف الالتقاط عند هذه النقطة.`);
          closeFrame(cur);
          break;
        }
        if (m.err > WARN_ERR) warn(null, `خطوة ${i}: تطابق متوسط (${Math.round(m.err * 100)}%)، راجع موضع الوصل.`);

        if (Math.abs(m.dx) < Math.abs(exp) * 0.2) {
          closeFrame(cur);
          if (++stalls >= 2) { warn('end', 'الشارت توقّف عن الحركة، غالباً وصلنا لنهاية البيانات المتاحة.'); break; }
          continue;
        }
        stalls = 0;
        if (!tryAccept(cur, m)) break;
        ok = await trackVertical();
      }
    } else {
      let bad = 0;
      while (!state.stop) {
        state.status = `التقاط يدوي: حرّك الشارت الآن (${st.frames} مقطع)`;
        await sleep(opts.intervalMs);
        await prep();

        const cur = await grabS();
        const m = findShift2D(prev, cur, {
          dxLo: -Math.round(cur.w * 0.8), dxHi: Math.round(cur.w * 0.8),
          dyLo: -Math.round(cur.h * 0.6), dyHi: Math.round(cur.h * 0.6),
        });

        if (m.err > REJECT_ERR) {
          bad++;
          if (bad === 1 || bad % 10 === 0) warn(null, 'تم تجاهل إطارات لم يمكن مطابقتها. حرّك الشارت أبطأ، ولا تغيّر الزوم أثناء الالتقاط.');
          closeFrame(cur);
          continue;
        }
        if (Math.abs(m.dx) < 2 && Math.abs(m.dy) < 2) { closeFrame(cur); continue; }
        if (!tryAccept(cur, m)) break;
      }
    }
  } catch (e) {
    if (state.detached) warn(null, 'تم فصل الالتقاط (أُغلق شريط التصحيح أو التبويب).');
    else { warn(null, 'خطأ: ' + (e?.message || e)); state.status = 'خطأ: ' + (e?.message || e); }
  } finally {
    try { await exec(tabId, pageRestore); } catch {}
    if (attached && !state.detached) { try { await chrome.debugger.detach({ tabId }); } catch {} }
  }

  try {
    if (st && st.frames) {
      state.status = 'دمج الصورة…';
      const out = await compose(st, opts.includeAxis);
      await putResult({ ...out, frames: st.frames, warnings, mode, createdAt: Date.now() });
      await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });
      state.status = `تم: ${st.frames} مقطع، ${out.width}×${out.height}px`;
    }
  } catch (e) {
    state.status = 'فشل الدمج: ' + (e?.message || e);
  } finally {
    if (st) { st.main.free(); st.axis.free(); st.lower.free(); }
    state.running = false;
    badge('');
  }
}
