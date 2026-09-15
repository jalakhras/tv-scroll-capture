const COV_SIZE=140000,COV_OFF=70000;
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

const WW=6000,WH=2400,world=new Uint8Array(WW*WH).fill(23);
for(let y=0;y<WH;y+=80)for(let x=0;x<WW;x++)world[y*WW+x]=40;
for(let x=0;x<WW;x+=150)for(let y=0;y<WH;y++)world[y*WW+x]=45;
let seed=11;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
let price=1800;
for(let x=5;x<WW-8;x+=9){price+=(x>2500&&x<3500?-9:0)+(rnd()-.5)*30;price=Math.max(60,Math.min(WH-200,price));
 const t=Math.round(price-40*rnd()),b=Math.round(price+60*rnd()+10);for(let y=t;y<b;y++)for(let k=0;k<6;k++)world[y*WW+x+k]=rnd()>.5?110:107;}
const W=1500,H=700;
const frame=(ox,oy)=>{const g=new Uint8Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)g[y*W+x]=world[(y+oy)*WW+x+ox];const s4=downsample(g,W,H,4);const bg=modeGray(s4.g);s4.bg=bg;return {g,w:W,h:H,k:1,s4,bg};};
// pick frames that actually contain candles
const inkAt=(ox,oy)=>{let n=0;for(let y=0;y<H;y+=5)for(let x=0;x<W;x+=5)if(world[(y+oy)*WW+x+ox]>90)n++;return n;};
const covSt=(X,Y)=>{const st={X,Y,covTop:new Float64Array(COV_SIZE).fill(Infinity),covBot:new Float64Array(COV_SIZE).fill(-Infinity)};for(let x=0;x<W;x++){st.covTop[X+x+COV_OFF]=Y;st.covBot[X+x+COV_OFF]=Y+H;}return st;};
// scan for top/bottom clipping windows along the rally
for(const [ox,oy] of [[2800,1300],[3300,300],[1000,1500],[1000,1100]]){console.log("clip @",ox,oy,JSON.stringify(clipInfo(frame(ox,oy),covSt(0,0))));}
const f=frame(1000,1500),st=covSt(0,0);for(let x=0;x<W;x++)st.covTop[x+COV_OFF]=-500;console.log("same frame, area above already covered ->",JSON.stringify(clipInfo(f,st)));
