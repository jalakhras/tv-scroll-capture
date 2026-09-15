import { getResult } from './idb.js';
import { getLang, setLang, t, tm, applyDom } from './i18n.js';

const $ = (id) => document.getElementById(id);
let lang = await getLang();
const r = await getResult();

function render() {
  applyDom(lang);
  $('lang').value = lang;
  if (!r?.blob) return;
  const mode = t(lang, r.mode === 'auto' ? 'modeAuto' : 'modeManual');
  $('meta').textContent = t(lang, 'meta', { w: r.width, h: r.height, frames: r.frames, mode });
  $('warnings').replaceChildren(...(r.warnings || []).map((w) => {
    const li = document.createElement('li');
    li.textContent = tm(lang, w);
    return li;
  }));
  $('fit').textContent = t(lang, $('stage').classList.contains('fit') ? 'native' : 'fit');
}

$('lang').onchange = async () => { lang = $('lang').value; await setLang(lang); render(); };

if (!r?.blob) {
  $('stage').hidden = true;
  $('empty').hidden = false;
  for (const el of document.querySelectorAll('.actions > :not(#lang)')) el.hidden = true;
  render();
} else {
  const url = URL.createObjectURL(r.blob);
  const img = $('img');
  img.onload = () => {
    // Show at native device pixels so candles look exactly as on the chart
    img.style.width = `${img.naturalWidth / devicePixelRatio}px`;
  };
  img.src = url;

  const when = new Date(r.createdAt);
  const stamp = when.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dl = $('download');
  dl.href = url;
  dl.download = `TradingView_scroll_${stamp}.png`;

  $('fit').onclick = () => { $('stage').classList.toggle('fit'); render(); };

  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': r.blob })]);
      $('copy').textContent = t(lang, 'copied');
    } catch {
      $('copy').textContent = t(lang, 'copyFailed');
    }
    setTimeout(() => ($('copy').textContent = t(lang, 'copy')), 1800);
  };

  render();
}
