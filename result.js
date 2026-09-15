import { getResult } from './idb.js';

const $ = (id) => document.getElementById(id);
const r = await getResult();

if (!r?.blob) {
  $('stage').hidden = true;
  $('empty').hidden = false;
  document.querySelector('.actions').hidden = true;
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
  $('meta').textContent = `${r.width}×${r.height}px، ${r.frames} مقطع، ${r.mode === 'auto' ? 'آلي' : 'يدوي'}`;

  const dl = $('download');
  dl.href = url;
  dl.download = `TradingView_scroll_${stamp}.png`;

  for (const w of r.warnings || []) {
    const li = document.createElement('li');
    li.textContent = w;
    $('warnings').append(li);
  }

  $('fit').onclick = () => {
    const on = $('stage').classList.toggle('fit');
    $('fit').textContent = on ? 'الحجم الأصلي' : 'احتواء في الشاشة';
  };

  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': r.blob })]);
      $('copy').textContent = 'تم النسخ';
    } catch {
      $('copy').textContent = 'تعذّر النسخ';
    }
    setTimeout(() => ($('copy').textContent = 'نسخ الصورة'), 1800);
  };
}
