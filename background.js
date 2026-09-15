import { putResult, putDebug } from './idb.js';
import { getLang, t } from './i18n.js';

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
  debug: false,         // save raw frames + a step log to IndexedDB (debug.html)
};
const MAX_SIDE = 32000;           // final image side limit
const MAX_AREA = 200_000_000;     // final image pixel limit
const CANVAS_SIDE = 32767, CANVAS_AREA = 268_000_000; // Chrome hard limits
// normalised mismatch (0 = identical); true matches score ~0.01-0.03
const THRESH = { auto: { warn: 0.06, reject: 0.15 }, manual: { warn: 0.12, reject: 0.3 } };
const COV_SIZE = 140000, COV_OFF = 70000;

// UI strings are stored as i18n keys (+ vars) so the popup renders them in its own language
const state = {
  running: false, mode: null, tabId: null, stop: false, detached: false,
  statusKey: 'stReady', statusVars: null, frames: 0, widthPx: 0, heightPx: 0,
};
const setStatus = (key, vars = null) => { state.statusKey = key; state.statusVars = vars; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let traceCdp = false;
const cdp = async (tabId, method, params = {}) => {
  if (traceCdp) console.log('[tvsc] cdp >', method, method === 'Page.captureScreenshot' ? '' : JSON.stringify(params));
  const r = await chrome.debugger.sendCommand({ tabId }, method, params);
  if (traceCdp) console.log('[tvsc] cdp <', method);
  return r;
};
const exec = async (tabId, func, args = []) =>
  (await chrome.scripting.executeScript({ target: { tabId }, func, args }))[0]?.result;
// MAIN world: needed to reach window.TradingViewApi (page globals are invisible in the isolated world)
const execMain = async (tabId, func, args = []) =>
  (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args }))[0]?.result;
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
    const { running, mode, statusKey, statusVars, frames, widthPx, heightPx } = state;
    sendResponse({ running, mode, statusKey, statusVars, frames, widthPx, heightPx });
  } else if (msg.type === 'start') {
    if (state.running) sendResponse({ ok: false, errorKey: 'alreadyRunning' });
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

function pageHideOverlays(region, detail) {
  const list = (window.__tvscHidden = window.__tvscHidden || []);
  const added = [];
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
    if (detail && added.length < 40) {
      added.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 80), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) });
    }
  }
  return detail ? { total: list.length, added } : list.length;
}

// Diagnostics: what would receive a mouse event at (x, y)?
function pageElementAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const chain = [];
  for (let e = el, i = 0; e && i < 5; e = e.parentElement, i++) chain.push(e.tagName + (e.className ? '.' + String(e.className).split(' ')[0] : ''));
  return {
    tag: el.tagName, cls: String(el.className || '').slice(0, 80), id: el.id || '',
    pointerEvents: cs.pointerEvents, visibility: cs.visibility, cursor: cs.cursor,
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    chain, hasApi: !!(window.TradingViewApi || window.tvWidget), dpr: devicePixelRatio,
  };
}

// TradingView's own chart API (movement without mouse drags). Runs in the MAIN world.
// Conventions: scrollBars(n > 0) shows older bars, i.e. content moves right by n * barSpacing CSS px;
// shiftPx(dy > 0) moves content down by dy CSS px (price range shifted up).
function pageApi(cmd, a) {
  try {
    const api = window.TradingViewApi;
    if (!api || typeof api.activeChart !== 'function') return { ok: false, reason: 'no TradingViewApi' };
    const chart = api.activeChart();
    const ts = chart.getTimeScale();
    const panes = chart.getPanes();
    const pane = panes.find((p) => p.hasMainSeries && p.hasMainSeries()) || panes[0];
    const ps = pane.getMainSourcePriceScale();
    // Internal model (bar indices, loading state). Guarded: it is not part of the public API.
    const model = (() => { try { return chart.chartModel(); } catch { return null; } })();
    const series = (() => { try { return model ? model.mainSeries() : null; } catch { return null; } })();
    const snap = () => {
      const r = ps.getVisiblePriceRange();
      let bars = null, loading = null, endOfData = null;
      try { const br = model.timeScale().visibleBarsStrictRange(); if (br) bars = { first: br.firstBar(), last: br.lastBar() }; } catch {}
      try { loading = chart.getSeries().isLoading(); } catch {}
      try { endOfData = series.endOfData(); } catch {}
      return {
        ok: true, barSpacing: ts.barSpacing(), rightOffset: ts.rightOffset(), auto: ps.isAutoScale(),
        price: r, top: r ? ps.priceToCoordinate(r.to) : null, bottom: r ? ps.priceToCoordinate(r.from) : null,
        paneH: pane.getHeight(), mode: ps.getMode(), locked: ps.isLocked(), ratioLocked: chart.isPriceToBarRatioLocked(),
        panes: panes.length, bars, loading, endOfData,
        symbol: (() => { try { return chart.symbol(); } catch { return null; } })(),
        resolution: (() => { try { return chart.resolution(); } catch { return null; } })(),
      };
    };
    // setVisiblePriceRange() treats its argument as the *data* range and pads it with the
    // scale's margins (studies with labels request large ones), so the visible range and the
    // px-per-price ratio come out different from what was asked. Ask, measure the padding,
    // and ask again for the range that yields the target exactly.
    const setVisibleExact = (target) => {
      let req = { from: target.from, to: target.to };
      let v = null;
      for (let i = 0; i < 4; i++) {
        ps.setVisiblePriceRange(req);
        v = ps.getVisiblePriceRange();
        const eps = 1e-7 * Math.abs(target.to - target.from);
        if (Math.abs(v.to - target.to) <= eps && Math.abs(v.from - target.from) <= eps) break;
        const spanReq = req.to - req.from;
        const padTop = (v.to - req.to) / spanReq, padBot = (req.from - v.from) / spanReq;
        const spanNext = (target.to - target.from) / (1 + padTop + padBot);
        req = { to: target.to - padTop * spanNext, from: target.from + padBot * spanNext };
      }
      return v;
    };
    // Walk "a.b.c" in the chart's property tree (for reading override values back)
    const readProp = (key) => {
      try {
        let node = model.properties();
        for (const part of key.split('.')) node = node.childs()[part];
        return node.value();
      } catch { return undefined; }
    };
    switch (cmd) {
      case 'probe': return snap();
      case 'dataRange': {
        // min/max price of bars [first, last] and where those prices sit on the pane.
        // Rows are [time, open, high, low, close, ...]; missing indices are skipped.
        const bars = series.bars();
        let min = Infinity, max = -Infinity, n = 0;
        for (let i = a.first; i <= a.last; i++) {
          const row = bars.valueAt(i);
          if (!row || row.length < 4) continue;
          const h = row[2], l = row[3];
          if (Number.isFinite(h) && h > max) max = h;
          if (Number.isFinite(l) && l < min) min = l;
          n++;
        }
        if (!n || !Number.isFinite(min) || !Number.isFinite(max)) return { ok: false, reason: 'empty' };
        return { ok: true, min, max, yMin: ps.priceToCoordinate(min), yMax: ps.priceToCoordinate(max), paneH: pane.getHeight() };
      }
      case 'hideOverlayStudies': {
        // Studies drawn over the main pane on their own scale (Volume) rescale with every
        // scroll and cannot be stitched; hide them for the capture. Studies that share the
        // series scale (moving averages, bands) move with the candles and are kept.
        const mainIdx = panes.indexOf(pane);
        let seriesInner = null;
        try { seriesInner = chart.getSeries().priceScale()._priceScale || null; } catch {}
        const hidden = [];
        for (const { id } of chart.getAllStudies()) {
          try {
            const st = chart.getStudyById(id);
            if (st.paneIndex() !== mainIdx || !st.isVisible()) continue;
            const inner = st.priceScale()._priceScale || null;
            if (seriesInner && inner === seriesInner) continue;
            st.setVisible(false);
            hidden.push(id);
          } catch {}
        }
        return { ok: true, hidden };
      }
      case 'cursorTool': {
        let prev = null;
        try { prev = api.selectedLineTool(); } catch {}
        api.selectLineTool(a.id);
        return { ok: true, prev };
      }
      case 'showStudies': {
        for (const id of a.ids) { try { chart.getStudyById(id).setVisible(true); } catch {} }
        return { ok: true };
      }
      case 'overrides': {
        const prev = {};
        for (const key of Object.keys(a.set)) prev[key] = readProp(key);
        chart.applyOverrides(a.set);
        return { ok: true, prev };
      }
      case 'autoScale': ps.setAutoScale(!!a.on); return snap();
      case 'scrollBars': chart.scrollChartByBar(a.n); return snap();
      case 'setRightOffset': ts.setRightOffset(a.v); return snap();
      case 'setPriceRange': setVisibleExact(a.range); return snap();
      case 'shiftPx': {
        // Works for linear and log scales: convert the pane's edge coordinates, not prices.
        const r = ps.getVisiblePriceRange();
        const yTop = ps.priceToCoordinate(r.to), yBot = ps.priceToCoordinate(r.from);
        const to = ps.coordinateToPrice(yTop - a.dy), from = ps.coordinateToPrice(yBot - a.dy);
        setVisibleExact({ from, to });
        const out = snap();
        out.spanBefore = r.to - r.from; out.spanAfter = out.price ? out.price.to - out.price.from : null;
        out.actual = ps.priceToCoordinate(r.to) - yTop; // measured shift of the old top edge
        return out;
      }
      default: return { ok: false, reason: 'unknown cmd' };
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

// Diagnostics: does the page still paint? (rAF within 400 ms, visibility, focus)
function pageFrameProbe() {
  return new Promise((resolve) => {
    const t = performance.now();
    let done = false;
    requestAnimationFrame(() => { if (!done) { done = true; resolve({ raf: Math.round(performance.now() - t), vis: document.visibilityState, focus: document.hasFocus() }); } });
    setTimeout(() => { if (!done) { done = true; resolve({ raf: null, vis: document.visibilityState, focus: document.hasFocus() }); } }, 1000);
  });
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
// Pixels that are identical ink in both frames at zero shift belong to overlays that do not
// scroll with the chart (grid lines, live price line, watermark, labels). They are excluded
// from scoring, otherwise a correct shift still looks bad on a busy real chart.
function staticMask(A, B) {
  const a = A.g, b = B.g, n = a.length, bga = A.bg, bgb = B.bg, T = A.T;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const va = a[i], vb = b[i];
    if ((va > bga ? va - bga : bga - va) > T && (vb > bgb ? vb - bgb : bgb - vb) > T &&
        (va > vb ? va - vb : vb - va) <= T) m[i] = 1;
  }
  return m;
}

// Robust score: rows are ranked by their own mismatch and the worst rows (up to 50% of the
// ink) are dropped. Overlays that rescale with the visible range (e.g. the volume histogram
// at the pane bottom) then no longer hide a correct match. A wrong shift is bad everywhere,
// so it still scores badly.
const KEEP_INK = 0.5;

function sad2(A, B, dx, dy, step, strict = false) {
  const w = A.w, h = A.h, a = A.g, b = B.g, bga = A.bg, bgb = B.bg, T = A.T, skip = B.skip;
  const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
  if (x1 - x0 < w * 0.2 || y1 - y0 < h * 0.3) return Infinity;
  // Full-resolution frames tolerate 1 px of jitter: with a fractional devicePixelRatio the
  // chart snaps candle edges differently from one frame to the next, so exact ink masks
  // disagree along every edge even at the correct shift. (Not applied at quarter scale.)
  const tol = !A.small && !strict;
  const inkA = (i) => (a[i] > bga ? a[i] - bga : bga - a[i]) > T;
  const inkB = (i) => (b[i] > bgb ? b[i] - bgb : bgb - b[i]) > T;
  const nearA = (i, x, y) => {
    for (let yy = -1; yy <= 1; yy++) { const yq = y + yy; if (yq < 0 || yq >= h) continue;
      for (let xx = -1; xx <= 1; xx++) { const xq = x + xx; if (xq < 0 || xq >= w) continue; if (inkA(yq * w + xq)) return true; } }
    return false;
  };
  const nearB = (i, x, y) => {
    for (let yy = -1; yy <= 1; yy++) { const yq = y + yy; if (yq < 0 || yq >= h) continue;
      for (let xx = -1; xx <= 1; xx++) { const xq = x + xx; if (xq < 0 || xq >= w) continue; if (inkB(yq * w + xq)) return true; } }
    return false;
  };
  // Compare "ink" masks (candles, text): weak pixels such as grid lines and
  // background are ignored, so empty or grid-only overlaps cannot match.
  let uni = 0, bad = 0, n = 0;
  const rows = [];
  for (let y = y0; y < y1; y += step) {
    const ra = y * w, rb = (y + dy) * w + dx;
    let ru = 0, rbad = 0;
    for (let x = x0; x < x1; x += step) {
      if (skip && (skip[ra + x] || skip[rb + x])) continue;
      const va = a[ra + x], vb = b[rb + x];
      const sa = (va > bga ? va - bga : bga - va) > T;
      const sb = (vb > bgb ? vb - bgb : bgb - vb) > T;
      n++;
      if (sa || sb) {
        ru++;
        if (sa && sb) { if ((va > vb ? va - vb : vb - va) > T) rbad++; }
        else if (!tol) rbad++;
        else if (sa ? !nearB(rb + x, x + dx, y + dy) : !nearA(ra + x, x, y)) rbad++;
      }
    }
    if (ru) { uni += ru; bad += rbad; rows.push(rbad / ru, ru, rbad); }
  }
  if (uni < Math.max(12, n * 0.002)) return 1;
  // trimmed score over the best rows
  const idx = [];
  for (let i = 0; i < rows.length; i += 3) idx.push(i);
  idx.sort((p, q) => rows[p] - rows[q]);
  let ku = 0, kb = 0;
  for (const i of idx) { ku += rows[i + 1]; kb += rows[i + 2]; if (ku >= uni * KEEP_INK) break; }
  const frac = ((x1 - x0) * (y1 - y0)) / (w * h);
  return kb / ku + 0.03 * (1 - frac);
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
  if (!c.skip) { c.skip = staticMask(p, c); c.s4.skip = staticMask(p.s4, c.s4); }
  const n4 = ((r.dxHi - r.dxLo) / 4 + 1) * ((r.dyHi - r.dyLo) / 4 + 1);
  const seed = n4 <= 4000
    ? grid(p.s4, c.s4, Math.floor(r.dxLo / 4), Math.ceil(r.dxHi / 4),
        Math.floor(r.dyLo / 4), Math.ceil(r.dyHi / 4), 1, 1)[0]
    : findShiftWide(p, c, r);
  if (!seed) return { dx: 0, dy: 0, err: Infinity };
  // Full-resolution refinement. The tolerant score is flat over a +-1 px plateau, so the exact
  // (strict) score breaks the tie among the candidates that share the best tolerant score.
  const cands = grid(p, c, seed.dx * 4 - 5, seed.dx * 4 + 5, seed.dy * 4 - 5, seed.dy * 4 + 5, 2, 9);
  if (!cands.length) return { dx: 0, dy: 0, err: Infinity };
  const top = cands.filter((q) => q.e <= cands[0].e + 0.004);
  let best = null;
  for (const q of top) {
    const es = sad2(p, c, q.dx, q.dy, 1, true);
    if (!best || es < best.es) best = { dx: q.dx, dy: q.dy, err: q.e, es };
  }
  return { dx: best.dx, dy: best.dy, err: best.err };
}

// 1-D horizontal match on a strip (the time axis): ink-mask mismatch for dx in [lo, hi].
// The time axis is never clipped by the price window, so it verifies a horizontal step even
// when the pane itself shows no candles. Returns the best dx, its error and the runner-up gap.
function matchStrip(A, B, w, h, bg, T, lo, hi) {
  let best = { dx: 0, err: Infinity }, second = Infinity;
  for (let dx = lo; dx <= hi; dx++) {
    const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
    if (x1 - x0 < w * 0.3) continue;
    let uni = 0, bad = 0;
    for (let y = 0; y < h; y++) {
      const ra = y * w, rb = y * w + dx;
      for (let x = x0; x < x1; x++) {
        const va = A[ra + x], vb = B[rb + x];
        const sa = Math.abs(va - bg) > T, sb = Math.abs(vb - bg) > T;
        if (!(sa || sb)) continue;
        uni++;
        if (sa && sb) { if (Math.abs(va - vb) > T) bad++; continue; }
        // 1 px horizontal tolerance (sub-pixel snapping at fractional DPR)
        const ok = sa
          ? (x + dx > x0 + 1 && Math.abs(B[rb + x - 1] - bg) > T) || (x + dx + 1 < w && Math.abs(B[rb + x + 1] - bg) > T)
          : (x > 0 && Math.abs(A[ra + x - 1] - bg) > T) || (x + 1 < w && Math.abs(A[ra + x + 1] - bg) > T);
        if (!ok) bad++;
      }
    }
    if (uni < 40) continue;
    const e = bad / uni;
    if (e < best.err) { second = best.err; best = { dx, err: e }; }
    else if (e < second) second = e;
  }
  best.gap = second - best.err;
  return best;
}

// 1-D vertical match on the price-axis strip: its labels move with the price window, so a
// vertical move can be verified even when the pane shows few candles.
function matchStripV(A, B, w, h, bg, T, lo, hi) {
  let best = { dy: 0, err: Infinity }, second = Infinity;
  for (let dy = lo; dy <= hi; dy++) {
    const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
    if (y1 - y0 < h * 0.3) continue;
    let uni = 0, bad = 0;
    for (let y = y0; y < y1; y++) {
      const ra = y * w, rb = (y + dy) * w;
      for (let x = 0; x < w; x++) {
        const va = A[ra + x], vb = B[rb + x];
        const sa = Math.abs(va - bg) > T, sb = Math.abs(vb - bg) > T;
        if (!(sa || sb)) continue;
        uni++;
        if (sa && sb) { if (Math.abs(va - vb) > T) bad++; continue; }
        const ok = sa
          ? (y + dy > y0 && Math.abs(B[rb + x - w] - bg) > T) || (y + dy + 1 < h && Math.abs(B[rb + x + w] - bg) > T)
          : (y > 0 && Math.abs(A[ra + x - w] - bg) > T) || (y + 1 < h && Math.abs(A[ra + x + w] - bg) > T);
        if (!ok) bad++;
      }
    }
    if (uni < 40) continue;
    const e = bad / uni;
    if (e < best.err) { second = best.err; best = { dy, err: e }; }
    else if (e < second) second = e;
  }
  best.gap = second - best.err;
  return best;
}

// Fraction of "ink" pixels in the quarter-scale frame (0 = blank pane)
function inkFrac(f) {
  const g = f.s4.g, bg = f.s4.bg, T = f.s4.T;
  let n = 0;
  for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - bg) > T) n++;
  return n / g.length;
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
  // Ink along most of an edge is an overlay drawn against it (volume histogram), not clipping.
  const overlay = w * 0.35;
  return { top: top >= need && top < overlay, bottom: bottom >= need && bottom < overlay };
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
async function grab(tabId, L, onShot) {
  const P = L.pane;
  const boxW = (L.axis ? L.axis.x + L.axis.w : P.x + P.w) - P.x;
  const boxH = L.bottom - P.y;
  const shot = await cdp(tabId, 'Page.captureScreenshot', {
    format: 'png', fromSurface: true,
    clip: { x: P.x + L.scrollX, y: P.y + L.scrollY, width: boxW, height: boxH, scale: 1 },
  });
  if (onShot) onShot(shot.data);
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
  s4.bg = bg; s4.T = 40; s4.small = true; // high enough to ignore faint watermarks and grid

  const f = {
    bmp: c.transferToImageBitmap(), g, w, h, k, s4, spec: null,
    bg, T: 40, bgRGB: findRGB(img, g, bg), axis: null, axisG: null, lower: null,
  };
  if (L.axis) {
    const ax = Math.round((L.axis.x - P.x) * k), aw = bmp.width - ax;
    if (aw > 0) { f.axis = await createImageBitmap(bmp, ax, 0, aw, h); f.axisG = bitmapGray(f.axis); f.axisW = aw; }
  }
  if (bmp.height - h > 2) {
    f.lower = await createImageBitmap(bmp, 0, h, w, bmp.height - h);
    f.lowerG = bitmapGray(f.lower); f.lowerH = f.lower.height; // date labels: 1-D horizontal check
  }
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
  const warnings = []; // [{ key, vars }] rendered by the result page in its own language
  const seen = new Set();
  const warn = (once, key, vars = null) => { if (once) { if (seen.has(once)) return; seen.add(once); } warnings.push({ key, vars }); };

  // ---- diagnostics (opts.debug) ----
  const t0 = Date.now();
  const dbg = opts.debug ? { log: [], frames: [], layout: null, mode, opts, createdAt: t0 } : null;
  traceCdp = !!dbg;
  const MAX_DBG_FRAMES = 40;
  let nextShotLabel = null;
  const dlog = (event, data = {}) => { if (dbg) { dbg.log.push({ t: Date.now() - t0, event, ...data }); console.log('[tvsc]', event, JSON.stringify(data).slice(0, 400)); } };
  const onShot = (b64) => {
    if (!dbg || dbg.frames.length >= MAX_DBG_FRAMES) return;
    const bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    dbg.frames.push({ label: nextShotLabel || `frame ${dbg.frames.length}`, t: Date.now() - t0, blob: new Blob([u8], { type: 'image/png' }) });
    nextShotLabel = null;
  };
  // Zero-shift score without the static mask: if the chart did not move, all ink is "static".
  const zeroScore = (a, b) => (a && b ? sad2(a.s4, { ...b.s4, skip: null }, 0, 0, 1) : null);

  let attached = false, st = null, prev = null;
  const progress = () => {
    const b = st.main.b;
    state.frames = st.frames; state.widthPx = b.x1 - b.x0; state.heightPx = b.y1 - b.y0;
  };

  let api0 = null; // chart state before we touched it (restored in finally)
  try {
    setStatus('stLayout');
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    // The debugger infobar pushes the page down; detect the layout only after it has settled.
    await sleep(350);
    let L = await exec(tabId, pageDetectLayout);
    for (let i = 0; i < 4 && L; i++) {
      await sleep(250);
      const L2 = await exec(tabId, pageDetectLayout);
      if (L2 && L2.pane.y === L.pane.y && L2.pane.h === L.pane.h && L2.bottom === L.bottom) break;
      L = L2;
    }
    dlog('layout', { layout: L });
    if (dbg) dbg.layout = L;
    if (!L || L.pane.w < 100 || L.pane.h < 60) throw Object.assign(new Error('chart area not found'), { key: 'errNoChart' });

    // Movement backend: TradingView's chart API when present (deterministic), CDP drags otherwise.
    const probe = await execMain(tabId, pageApi, ['probe']).catch(() => null);
    const useApi = !!(probe && probe.ok && probe.barSpacing > 0);
    if (useApi) api0 = probe;
    dlog('mover', { useApi, probe });
    if (dbg) dbg.mover = useApi ? 'api' : 'drag';

    // Overlays that TradingView paints on the canvas itself (live price line and axis labels)
    // would repeat at every seam; switch them off for the capture and restore them at the end.
    if (useApi && opts.hideOverlays) {
      const set = {
        'mainSeriesProperties.showPriceLine': false,
        'mainSeriesProperties.showCountdown': false,
        'scalesProperties.showSeriesLastValue': false,
        'scalesProperties.showPrePostMarketPriceLabel': false,
        'scalesProperties.showStudyLastValue': false,
        'scalesProperties.showPriceScaleCrosshairLabel': false,
        'scalesProperties.showTimeScaleCrosshairLabel': false,
        'mainSeriesProperties.esdShowDividends': false,
        'mainSeriesProperties.esdShowSplits': false,
        'mainSeriesProperties.esdShowEarnings': false,
      };
      const r = await execMain(tabId, pageApi, ['overrides', { set }]).catch(() => null);
      if (r && r.ok) {
        const restore = {};
        for (const [key, v] of Object.entries(r.prev)) if (v !== undefined) restore[key] = v;
        api0 = { ...api0, restoreOverrides: restore };
      }
      dlog('api', { cmd: 'overrides', result: r });
      // The crosshair follows the user's mouse; the arrow cursor draws none.
      const tool = await execMain(tabId, pageApi, ['cursorTool', { id: 'arrow_cursor' }]).catch(() => null);
      if (tool && tool.ok && tool.prev && tool.prev !== 'arrow_cursor') api0 = { ...api0, restoreTool: tool.prev };
      dlog('api', { cmd: 'cursorTool', result: tool });
      const h = await execMain(tabId, pageApi, ['hideOverlayStudies']).catch(() => null);
      if (h && h.ok && h.hidden.length) api0 = { ...api0, hiddenStudies: h.hidden };
      dlog('api', { cmd: 'hideOverlayStudies', result: h });
    }
    const apiProbe = () => execMain(tabId, pageApi, ['probe']).catch(() => null);
    // History is fetched on demand while scrolling into the past: wait until the series is idle.
    const waitLoaded = async () => {
      if (!useApi) return null;
      let p2 = null;
      for (let i = 0; i < 20; i++) {
        p2 = await apiProbe();
        if (!p2 || !p2.ok || !p2.loading) break;
        await sleep(150);
      }
      return p2;
    };

    const P = L.pane;
    const hideRect = { x: P.x, y: P.y, w: P.w, h: L.bottom - P.y };
    const parkMouse = () => cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    let hideLogged = false;
    const prep = async () => {
      if (!opts.hideOverlays) return;
      const r = await exec(tabId, pageHideOverlays, [hideRect, !!dbg && !hideLogged]);
      if (dbg && !hideLogged) { hideLogged = true; dlog('hideOverlays', { result: r }); }
    };
    // After an API move the chart repaints on its next animation frame; wait for one so the
    // screenshot is not stale (a hidden/occluded window produces no frames at all).
    const waitPaint = async () => {
      const f = await exec(tabId, pageFrameProbe);
      if (f && f.raf === null) {
        // nudge: synthetic input forces a frame even when the page is not painting
        await parkMouse();
        const g = await exec(tabId, pageFrameProbe);
        dlog('paint', { first: f, afterNudge: g });
        if (g && g.raf === null) warn('nopaint', 'wNoPaint');
      }
    };
    const settle = async () => {
      if (useApi) { await waitLoaded(); await waitPaint(); } else await parkMouse();
      await sleep(opts.settleMs);
      await prep();
      await sleep(80);
    };
    let screen = null; // latest grabbed frame, used to find empty spots to drag from
    const grabS = async (label) => { nextShotLabel = label || null; return (screen = await grab(tabId, L, dbg ? onShot : null)); };
    // move(dx, dy): request a content shift in CSS px; returns the shift actually requested
    // (the API mover rounds horizontal moves to whole bars).
    const move = async (dx, dy) => {
      if (useApi) {
        let ax = 0, ay = 0;
        if (dx) {
          const n = Math.max(1, Math.round(Math.abs(dx) / probe.barSpacing)) * Math.sign(dx);
          const r = await execMain(tabId, pageApi, ['scrollBars', { n }]);
          ax = n * (r && r.barSpacing || probe.barSpacing);
          dlog('api', { cmd: 'scrollBars', n, result: r, frame: dbg ? await exec(tabId, pageFrameProbe) : null });
        }
        if (dy) {
          const r = await execMain(tabId, pageApi, ['shiftPx', { dy }]);
          ay = r && r.ok && Number.isFinite(r.actual) ? r.actual : dy;
          dlog('api', { cmd: 'shiftPx', dy, result: r });
        }
        return { dx: ax, dy: ay };
      }
      const start = screen ? pickStart(screen, L, dx, dy) : null;
      if (!start) warn('nostart', 'wNoStart');
      const s = start || { x: Math.round(P.x + P.w / 2 - dx / 2), y: Math.round(P.y + P.h / 2 - dy / 2) };
      if (dbg) dlog('drag', { dxCss: dx, dyCss: dy, start: s, pickedEmpty: !!start, target: await exec(tabId, pageElementAt, [s.x, s.y]) });
      await drag(tabId, L, dx, dy, start);
      return { dx, dy };
    };

    if (mode === 'auto' && !useApi) { await parkMouse(); await sleep(150); }
    await prep();
    await sleep(120);

    if (opts.autoScaleOff) {
      setStatus('stAutoScale');
      if (useApi) {
        if (probe.auto) dlog('api', { cmd: 'autoScale', result: await execMain(tabId, pageApi, ['autoScale', { on: false }]) });
      } else {
        // Drag fallback: a vertical pan makes TradingView switch Auto Scale off; pan back to the same place
        const before = await grabS('before auto-scale nudge');
        await move(0, 40);
        await sleep(250);
        await move(0, -40);
        closeFrame(before);
      }
      await settle();
    }

    st = makeStitcher();
    prev = await grabS('frame 0 (base)');
    accept(st, prev, 0, 0);
    progress();

    const k = prev.k;
    const tol = Math.round(8 * k);

    const tryAccept = (cur, m) => {
      if (!accept(st, cur, m.dx, m.dy)) {
        warn('cap', 'wCap');
        closeFrame(cur);
        return false;
      }
      prev = cur;
      progress();
      return true;
    };

    // API mover: the shift is known from the chart model; matching only refines it by a few px
    // and guards against a stale frame. Returns the shift to stitch with, or null to stop.
    // The model's shift is only a prediction: on real charts the rendered shift was seen to
    // differ by a few px (562 vs 558) after history loads. The pane match decides; for
    // horizontal steps the time-axis strip is a second witness that is immune to the price
    // window and to overlays. Returns the shift to stitch with, or null to stop.
    const verifyApi = (cur, exp, m, label) => {
      const ex = Math.round(exp.dx), ey = Math.round(exp.dy);
      const near = (v, e) => Math.abs(v - e) <= Math.max(12, Math.abs(e) * 0.05);
      const paneOk = Number.isFinite(m.err) && m.err <= REJECT_ERR && near(m.dx, ex) && near(m.dy, ey);
      let strip = null;
      if (ey === 0 && ex !== 0 && prev.lowerG && cur.lowerG && prev.lowerH === cur.lowerH) {
        strip = matchStrip(prev.lowerG, cur.lowerG, prev.w, prev.lowerH, prev.bg, prev.T, ex - 24, ex + 24);
        if (strip) strip.dy = 0;
      } else if (ex === 0 && ey !== 0 && prev.axisG && cur.axisG && prev.axisW === cur.axisW) {
        const v = matchStripV(prev.axisG, cur.axisG, prev.axisW, prev.h, prev.bg, prev.T, ey - 24, ey + 24);
        strip = { dx: 0, dy: v.dy, err: v.err, gap: v.gap };
      }
      const stripOk = strip && strip.err <= 0.35 && strip.gap >= 0.05;
      const z = zeroScore(prev, cur);
      dlog('verify', { label, expected: exp, measured: m, strip, zeroShift: z, paneOk, stripOk });
      if (paneOk && (!stripOk || (Math.abs(strip.dx - m.dx) <= 2 && Math.abs(strip.dy - m.dy) <= 2))) return m;
      if (stripOk && (!paneOk || m.err > WARN_ERR)) {
        // pane had too few candles (outside the price window) but the axis labels agree
        if (!paneOk) warn('strip', 'wStripOnly');
        return { dx: strip.dx, dy: strip.dy, err: strip.err };
      }
      if (paneOk) return m;
      if (z !== null && z < WARN_ERR) return null; // frame identical to the previous one: stale
      return null;
    };

    // Reveal candles cut at the top/bottom edge. Returns false if the size cap was hit.
    // API branch: compare the min/max price of the bars in `newBars` with the visible price
    // window (exact, unaffected by overlays); drag branch: look for ink at the pane edges.
    const trackVertical = async (newBars) => {
      if (!opts.verticalTrack) return true;
      let phase = 'below';
      for (let v = 0; v < opts.maxVert && !state.stop; v++) {
        let dyCss, arrow;
        if (useApi) {
          if (!newBars || newBars.first > newBars.last) return true;
          const d = await execMain(tabId, pageApi, ['dataRange', newBars]).catch(() => null);
          if (!d || !d.ok) return true;
          const below = d.yMin - d.paneH, above = -d.yMax; // px of candle outside the pane
          dlog('clip', { newBars, below: Math.round(below), above: Math.round(above), min: d.min, max: d.max, phase });
          // bottom first, then top; a side is finished once it is inside the pane
          if (phase === 'below' && below <= 1) phase = 'above';
          if (phase === 'above' && above <= 1) return true;
          // keep >= 40 % overlap: the matcher needs it (and 30 % is its hard floor)
          const room = Math.round(d.paneH * 0.6);
          if (phase === 'below') dyCss = -Math.min(Math.ceil(below) + 8, room);
          else dyCss = Math.min(Math.ceil(above) + 8, room);
          arrow = dyCss < 0 ? '↓' : '↑';
        } else {
          const clip = clipInfo(prev, st);
          if (!clip.top && !clip.bottom) return true;
          if (clip.top && clip.bottom) { warn('tall', 'wTall'); return true; }
          dyCss = (clip.top ? 1 : -1) * Math.round(P.h * 0.4);
          arrow = clip.top ? '↑' : '↓';
        }
        setStatus('stVertical', { arrow });
        const req = await move(0, dyCss);
        await settle();

        let cur = await grabS(`vertical ${arrow === '↑' ? 'up' : 'down'} ${v + 1}`);
        const exp = req.dy * k, span = useApi ? Math.abs(exp) * 0.1 + 8 * k : Math.abs(exp) * 0.5 + 20 * k;
        let m = findShift2D(prev, cur, { dxLo: -tol, dxHi: tol, dyLo: Math.round(exp - span), dyHi: Math.round(exp + span) });
        const lastErr = Number.isFinite(m.err) ? m.err : 1;
        dlog('match', { kind: 'vertical', expected: { dx: 0, dy: exp }, measured: m, zeroShift: zeroScore(prev, cur) });
        if (useApi) {
          m = verifyApi(cur, { dx: 0, dy: exp }, m, 'vertical');
          if (!m) {
            // stale frame (chart had not repainted yet): one more chance
            closeFrame(cur);
            await sleep(Math.max(600, opts.settleMs));
            await settle();
            cur = await grabS(`vertical ${arrow === '↑' ? 'up' : 'down'} ${v + 1} (retry)`);
            m = findShift2D(prev, cur, { dxLo: -tol, dxHi: tol, dyLo: Math.round(exp - span), dyHi: Math.round(exp + span) });
            m = verifyApi(cur, { dx: 0, dy: exp }, m, 'vertical retry');
          }
          if (!m) {
            // Put the price window back where the last accepted frame was taken, otherwise the
            // next horizontal frame sits at a different height and cannot be matched.
            closeFrame(cur);
            warn(null, 'wVertWeak', { pct: Math.round(Math.min(1, lastErr) * 100) });
            await move(0, -req.dy);
            await settle();
            return true;
          }
        } else if (m.err > REJECT_ERR) {
          warn(null, 'wVertWeak', { pct: Math.round(m.err * 100) });
          closeFrame(cur);
          await move(0, -dyCss); // restore position so the next horizontal match still lines up
          await settle();
          return true;
        } else if (Math.abs(m.dy) < Math.abs(exp) * 0.2) { closeFrame(cur); return true; }
        if (!tryAccept(cur, m)) return false;
      }
      if (useApi) warn('maxvert', 'wMaxVert');
      else { const clip = clipInfo(prev, st); if (clip.top || clip.bottom) warn('maxvert', 'wMaxVert'); }
      return true;
    };

    if (mode === 'auto') {
      const dir = opts.direction === 'left' ? 1 : -1; // drag right = older bars
      let lastBars = useApi ? (await waitLoaded())?.bars || null : null;
      let ok = await trackVertical(lastBars);
      const pct = Math.min(80, Math.max(10, Number(opts.stepPct) || 50));
      const stepCss = Math.max(40, Math.round((P.w * pct) / 100));
      let stalls = 0, scaleChecked = false;

      // Before a horizontal step make sure the bars that stay visible (the overlap) have their
      // candles inside the price window, otherwise the pane offers nothing to verify against.
      const ensureOverlapVisible = async () => {
        if (!useApi || !lastBars) return true;
        const nOut = Math.round(stepCss / probe.barSpacing);
        const keep = dir > 0 ? { first: lastBars.first, last: lastBars.last - nOut } : { first: lastBars.first + nOut, last: lastBars.last };
        if (keep.first > keep.last) return true;
        const d = await execMain(tabId, pageApi, ['dataRange', keep]).catch(() => null);
        if (!d || !d.ok) return true;
        const vis = Math.min(d.yMin, d.paneH) - Math.max(d.yMax, 0); // visible part of the candle span
        dlog('overlapCheck', { keep, yMax: Math.round(d.yMax), yMin: Math.round(d.yMin), paneH: d.paneH, vis: Math.round(vis) });
        if (vis >= Math.min(d.yMin - d.yMax, d.paneH) * 0.6) return true;
        let dyCss = Math.round(d.paneH / 2 - (d.yMax + d.yMin) / 2);
        dyCss = Math.max(-Math.round(d.paneH * 0.6), Math.min(Math.round(d.paneH * 0.6), dyCss));
        if (Math.abs(dyCss) < 4) return true;
        dlog('overlap', { keep, yMax: Math.round(d.yMax), yMin: Math.round(d.yMin), dyCss });
        setStatus('stVertical', { arrow: dyCss < 0 ? '↓' : '↑' });
        const req = await move(0, dyCss);
        await settle();
        const cur = await grabS('overlap reposition');
        const exp = req.dy * k, span = Math.abs(exp) * 0.1 + 8 * k;
        let m = findShift2D(prev, cur, { dxLo: -tol, dxHi: tol, dyLo: Math.round(exp - span), dyHi: Math.round(exp + span) });
        m = verifyApi(cur, { dx: 0, dy: exp }, m, 'overlap');
        if (!m) {
          closeFrame(cur);
          warn(null, 'wVertWeak', { pct: 100 });
          await move(0, -req.dy); // undo, keep the window where the last frame was taken
          await settle();
          return true;
        }
        return tryAccept(cur, m);
      };

      for (let i = 1; i <= opts.steps && ok && !state.stop; i++) {
        setStatus('stStep', { i, n: opts.steps });
        if (!(await ensureOverlapVisible())) break;
        const req = await move(dir * stepCss, 0);
        await settle();
        const exp = req.dx * k;
        const span = useApi ? Math.abs(exp) * 0.1 + 8 * k : Math.abs(exp) * 0.5 + 20 * k;

        let cur = await grabS(`step ${i}`);
        let m = findShift2D(prev, cur, { dxLo: Math.round(exp - span), dxHi: Math.round(exp + span), dyLo: -tol, dyHi: tol });
        if (useApi && m.err > WARN_ERR) {
          // History may still be loading after a scroll into the past: give it one more chance.
          closeFrame(cur);
          await sleep(Math.max(600, opts.settleMs));
          await waitLoaded();
          await prep();
          cur = await grabS(`step ${i} (retry)`);
          m = findShift2D(prev, cur, { dxLo: Math.round(exp - span), dxHi: Math.round(exp + span), dyLo: -tol, dyHi: tol });
        }
        const z = m.err > WARN_ERR || dbg ? zeroScore(prev, cur) : null;
        dlog('match', { kind: 'step', i, expected: { dx: exp, dy: 0 }, measured: m, zeroShift: z });

        let newBars = null, atEnd = false;
        if (useApi) {
          const p2 = await apiProbe();
          if (p2 && p2.ok && (p2.symbol !== probe.symbol || p2.resolution !== probe.resolution)) {
            // Someone switched the chart under us (watchlist click, hotkey): never stitch that.
            warn(null, 'wSymbolChanged', { from: probe.symbol, to: p2.symbol });
            closeFrame(cur);
            break;
          }
          if (p2 && p2.ok && p2.bars) {
            newBars = lastBars
              ? (dir > 0 ? { first: p2.bars.first, last: Math.min(p2.bars.last, lastBars.first - 1) }
                         : { first: Math.max(p2.bars.first, lastBars.last + 1), last: p2.bars.last })
              : p2.bars;
            // Reached the first bar (or the realtime edge): finish after this frame.
            atEnd = dir > 0 ? (p2.endOfData && p2.bars.first <= 0) : (p2.rightOffset >= (api0.rightOffset ?? 0) && i > 1 && p2.bars.last === lastBars.last);
            lastBars = p2.bars;
          }
          const v = verifyApi(cur, { dx: exp, dy: 0 }, m, `step ${i}`);
          if (!v) {
            const zz = z ?? zeroScore(prev, cur);
            if (zz < WARN_ERR) warn(null, 'wStall', { i, pct: Math.round((1 - zz) * 100) });
            else warn(null, 'wStepWeak', { i, pct: Math.round(Math.min(1, m.err) * 100) });
            closeFrame(cur);
            break;
          }
          m = v;
        }

        if (!scaleChecked) {
          scaleChecked = true;
          const p2 = useApi ? await execMain(tabId, pageApi, ['probe']).catch(() => null) : null;
          // Same price span = same px per price unit (the range itself moves with vertical tracking)
          const span0 = probe.price ? probe.price.to - probe.price.from : 0;
          const apiScaleSame = p2 && p2.ok && p2.price && span0 > 0 &&
            Math.abs((p2.price.to - p2.price.from) - span0) < 1e-6 * span0;
          if (p2) dlog('scaleCheck', { before: probe.price, after: p2.price, same: apiScaleSame });
          if (useApi ? !apiScaleSame : (Math.abs(m.dy) <= 1 && axisChanged(prev.axisG, cur.axisG))) {
            if (m.err > WARN_ERR) {
              warn('scale', 'wScale');
              closeFrame(cur);
              break;
            }
            warn('scale-soft', 'wScaleSoft');
          }
        }
        if (useApi && m.err > REJECT_ERR && inkFrac(cur) < 0.002) {
          // Scrolled past the first/last bar: the pane is blank now.
          warn('end', 'wEnd');
          closeFrame(cur);
          break;
        }
        if (m.err > REJECT_ERR) {
          // A near-perfect zero-shift match means the chart did not move at all (the drag
          // never reached it) rather than a bad stitch; say so instead of "weak match".
          if (z !== null && z < WARN_ERR) warn(null, 'wStall', { i, pct: Math.round((1 - z) * 100) });
          else warn(null, 'wStepWeak', { i, pct: Math.round(m.err * 100) });
          closeFrame(cur);
          break;
        }
        if (m.err > WARN_ERR) warn(null, 'wStepMid', { i, pct: Math.round(m.err * 100) });

        if (Math.abs(m.dx) < Math.abs(exp) * 0.2) {
          closeFrame(cur);
          if (++stalls >= 2) { warn('end', 'wEnd'); break; }
          continue;
        }
        stalls = 0;
        if (!tryAccept(cur, m)) break;
        ok = await trackVertical(newBars);
        if (atEnd) { warn('end', 'wEndReached'); break; }
      }
    } else {
      let bad = 0;
      while (!state.stop) {
        setStatus('stManual', { frames: st.frames });
        await sleep(opts.intervalMs);
        await prep();

        const cur = await grabS(dbg && dbg.frames.length < MAX_DBG_FRAMES ? `manual sample ${dbg.frames.length}` : null);
        const m = findShift2D(prev, cur, {
          dxLo: -Math.round(cur.w * 0.8), dxHi: Math.round(cur.w * 0.8),
          dyLo: -Math.round(cur.h * 0.6), dyHi: Math.round(cur.h * 0.6),
        });
        dlog('match', { kind: 'manual', measured: m, zeroShift: dbg ? zeroScore(prev, cur) : null });

        if (m.err > REJECT_ERR) {
          bad++;
          if (bad === 1 || bad % 10 === 0) warn(null, 'wManualSkip');
          closeFrame(cur);
          continue;
        }
        if (Math.abs(m.dx) < 2 && Math.abs(m.dy) < 2) { closeFrame(cur); continue; }
        if (!tryAccept(cur, m)) break;
      }
    }
  } catch (e) {
    dlog('error', { message: String(e?.message || e), detached: state.detached });
    if (state.detached) warn(null, 'wDetached');
    else if (e?.key) { warn(null, e.key); setStatus('stError', { msg: t(await getLang(), e.key) }); }
    else { warn(null, 'wError', { msg: String(e?.message || e) }); setStatus('stError', { msg: String(e?.message || e) }); }
  } finally {
    try { await exec(tabId, pageRestore); } catch {}
    if (api0 && !state.detached) {
      // Put the chart back where it was (F12): position, price range, Auto Scale.
      try {
        await execMain(tabId, pageApi, ['setRightOffset', { v: api0.rightOffset }]);
        if (api0.price) await execMain(tabId, pageApi, ['setPriceRange', { range: api0.price }]);
        if (api0.auto) await execMain(tabId, pageApi, ['autoScale', { on: true }]);
        if (api0.restoreOverrides) await execMain(tabId, pageApi, ['overrides', { set: api0.restoreOverrides }]);
        if (api0.hiddenStudies) await execMain(tabId, pageApi, ['showStudies', { ids: api0.hiddenStudies }]);
        if (api0.restoreTool) await execMain(tabId, pageApi, ['cursorTool', { id: api0.restoreTool }]);
      } catch {}
    }
    if (attached && !state.detached) { try { await chrome.debugger.detach({ tabId }); } catch {} }
  }

  if (dbg) {
    dlog('end', { frames: st ? st.frames : 0, warnings });
    try { await putDebug(dbg); } catch (e) { console.warn('debug save failed', e); }
  }

  try {
    if (st && st.frames) {
      setStatus('stCompose');
      const out = await compose(st, opts.includeAxis);
      await putResult({ ...out, frames: st.frames, warnings, mode, createdAt: Date.now() });
      await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });
      setStatus('stDone', { frames: st.frames, w: out.width, h: out.height });
    }
  } catch (e) {
    setStatus('stComposeFailed', { msg: String(e?.message || e) });
  } finally {
    if (st) { st.main.free(); st.axis.free(); st.lower.free(); }
    state.running = false;
    badge('');
  }
}
