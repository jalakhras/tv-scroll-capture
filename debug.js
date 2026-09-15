import { getDebug } from './idb.js';
import { getLang, setLang, t, applyDom } from './i18n.js';

const $ = (id) => document.getElementById(id);
let lang = await getLang();
const d = await getDebug();

applyDom(lang);
$('lang').value = lang;
$('lang').onchange = async () => { lang = $('lang').value; await setLang(lang); applyDom(lang); };

if (!d) {
  $('empty').hidden = false;
  for (const id of ['layoutSec', 'logSec', 'framesSec']) $(id).hidden = true;
  $('export').hidden = true;
} else {
  const when = new Date(d.createdAt).toISOString();
  $('meta').textContent = `${d.mode} · ${when} · ${d.log.length} events · ${d.frames.length} frames`;
  $('layout').textContent = JSON.stringify({ layout: d.layout, opts: d.opts }, null, 2);

  const tbody = $('log').querySelector('tbody');
  for (const e of d.log) {
    const { t: ms, event, ...rest } = e;
    const tr = document.createElement('tr');
    const isBad = event === 'error' || (event === 'match' && rest.measured && rest.measured.err > 0.15);
    tr.innerHTML = `<td>${ms}</td><td class="${isBad ? 'warn' : ''}">${event}</td><td class="json"></td>`;
    tr.lastElementChild.textContent = JSON.stringify(rest);
    tbody.append(tr);
  }

  for (const f of d.frames) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(f.blob);
    const cap = document.createElement('figcaption');
    cap.textContent = `${f.label} · t=${f.t}ms`;
    fig.append(cap, img);
    $('frames').append(fig);
  }

  const blobToDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

  $('export').onclick = async () => {
    const frames = [];
    for (const f of d.frames) frames.push({ label: f.label, t: f.t, png: await blobToDataUrl(f.blob) });
    const out = { version: chrome.runtime.getManifest().version, createdAt: d.createdAt, mode: d.mode, opts: d.opts, layout: d.layout, log: d.log, frames };
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tvsc-debug-${new Date(d.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
  };
}
