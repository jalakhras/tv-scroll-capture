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

const WW=6000,WH=3000,world=new Uint8Array(WW*WH).fill(23);
for(let y=0;y<WH;y+=80)for(let x=0;x<WW;x++)world[y*WW+x]=40;
for(let x=0;x<WW;x+=150)for(let y=0;y<WH;y++)world[y*WW+x]=45;
let seed=5;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
let price=1500,v=0;
for(let x=5;x<WW-8;x+=9){v=v*0.9+(rnd()-.5)*14+(x>2500&&x<3200?-4:0);price+=v;if(price<200){price=200;v=Math.abs(v);}if(price>WH-300){price=WH-300;v=-Math.abs(v);}
 const o=Math.round(price),c=Math.round(price+v*2+(rnd()-.5)*30),t=Math.min(o,c)-Math.round(20*rnd())-2,b=Math.max(o,c)+Math.round(20*rnd())+2;
 const col=c<o?112:98;for(let y=t;y<b;y++){const body=y>=Math.min(o,c)&&y<=Math.max(o,c);for(let k=body?0:2;k<(body?6:4);k++)world[y*WW+x+k]=col;}}
const W=1500,H=700;const wm=(g)=>{for(let y=300;y<420;y++)for(let x=600;x<1100;x++)if(((x>>5)+(y>>5))%2)g[y*W+x]=Math.max(g[y*W+x],50);return g;};
const frame=(ox,oy)=>{const g=new Uint8Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)g[y*W+x]=world[(y+oy)*WW+x+ox];wm(g);const s4=downsample(g,W,H,4);const bg=modeGray(s4.g);s4.bg=bg;s4.T=40;return {g,w:W,h:H,k:1,s4,bg,T:40,spec:null};};
// find vertical center of candles at given x to aim frames at data
const priceAt=x=>{for(let y=0;y<WH;y++)if(world[y*WW+x+2]>90)return y;return 1000;};
const at=(x)=>Math.max(0,Math.min(WH-H,priceAt(x+W/2)-H/2));
const tests=[];
for(let i=0;i<60;i++){const ax=600+Math.floor(rnd()*3800),ay=at(ax);const dx=Math.round((rnd()-.5)*2000),dy=Math.round((rnd()-.5)*700);const bx=ax-dx,by=Math.max(0,Math.min(WH-H,ay-dy));if(bx<0||bx>WW-W)continue;tests.push(["manual",[ax,ay],[bx,by],{dxLo:-1200,dxHi:1200,dyLo:-420,dyHi:420}]);}
{const ax=2000,ay=at(2000);tests.push(["auto h",[ax,ay],[ax-750,ay],{dxLo:375,dxHi:1125,dyLo:-8,dyHi:8}]);tests.push(["auto v",[ax,ay],[ax,ay-280],{dxLo:-8,dxHi:8,dyLo:140,dyHi:420}]);}
for(const [n,a,b,r] of tests){const exp=[a[0]-b[0],a[1]-b[1]];const fa=frame(...a),fb=frame(...b);const t=Date.now();const m=findShift2D(fa,fb,r);
 const valid=Math.abs(exp[0])<=1200&&Math.abs(exp[1])<=420&&W-Math.abs(exp[0])>=W*0.2&&H-Math.abs(exp[1])>=H*0.3;
 const ok=m.dx===exp[0]&&m.dy===exp[1];console.log(n.padEnd(7),"exp",String(exp).padEnd(10),"got",String([m.dx,m.dy]).padEnd(10),"err",m.err.toFixed(3),ok?"OK":(valid?(m.err>0.15?"REJECTED(safe)":"WRONG"):"out-of-range"),(Date.now()-t)+"ms");}

const pf=frame(2000,at(2000));const L={pane:{x:0,y:0,w:W,h:H}};console.log('pickStart', JSON.stringify(pickStart(pf,L,0,280)), JSON.stringify(pickStart(pf,L,750,0)));
