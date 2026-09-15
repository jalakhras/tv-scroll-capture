const $ = (id) => document.getElementById(id);
const FIELDS = ['direction', 'steps', 'stepPct', 'settleMs', 'intervalMs', 'hideOverlays', 'includeAxis', 'verticalTrack', 'maxVert', 'autoScaleOff'];
let tabId = null;
let isTv = false;

function readOpts() {
  const o = {};
  for (const f of FIELDS) {
    const el = $(f);
    o[f] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : Number(el.value);
  }
  return o;
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'getState' });
  if (!s) return;
  $('status').textContent = s.running && s.frames ? `${s.status} (${s.widthPx}×${s.heightPx}px)` : s.status;
  $('dot').classList.toggle('rec', s.running);
  $('stop').hidden = !s.running;
  document.querySelectorAll('button.start').forEach((b) => (b.disabled = s.running || !isTv));
}

async function start(mode) {
  const opts = readOpts();
  await chrome.storage.local.set({ opts });
  const res = await chrome.runtime.sendMessage({ type: 'start', mode, tabId, opts });
  if (!res?.ok) $('status').textContent = res?.error || 'تعذّر البدء';
  refresh();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  isTv = /^https:\/\/([a-z0-9-]+\.)*tradingview\.com\//i.test(tab?.url || '');
  $('notTv').hidden = isTv;

  const { opts } = await chrome.storage.local.get('opts');
  if (opts) {
    for (const f of FIELDS) {
      if (!(f in opts)) continue;
      const el = $(f);
      if (el.type === 'checkbox') el.checked = opts[f]; else el.value = opts[f];
    }
  }

  $('startAuto').onclick = () => start('auto');
  $('startManual').onclick = () => start('manual');
  $('stop').onclick = async () => { await chrome.runtime.sendMessage({ type: 'stop' }); refresh(); };

  refresh();
  setInterval(refresh, 400);
}

init();
