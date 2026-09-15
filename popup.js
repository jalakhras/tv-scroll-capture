import { getLang, setLang, t, applyDom } from './i18n.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['direction', 'steps', 'stepPct', 'settleMs', 'intervalMs', 'hideOverlays', 'includeAxis', 'verticalTrack', 'maxVert', 'autoScaleOff', 'debug'];
let tabId = null;
let isTv = false;
let lang = 'ar';

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
  const status = t(lang, s.statusKey, s.statusVars);
  $('status').textContent = s.running && s.frames ? `${status} (${s.widthPx}×${s.heightPx}px)` : status;
  $('dot').classList.toggle('rec', s.running);
  $('stop').hidden = !s.running;
  document.querySelectorAll('button.start').forEach((b) => (b.disabled = s.running || !isTv));
}

async function start(mode) {
  const opts = readOpts();
  await chrome.storage.local.set({ opts });
  const res = await chrome.runtime.sendMessage({ type: 'start', mode, tabId, opts });
  if (!res?.ok) $('status').textContent = res?.errorKey ? t(lang, res.errorKey) : res?.error || t(lang, 'startFailed');
  refresh();
}

async function switchLang(next) {
  lang = next;
  await setLang(next);
  applyDom(lang);
  $('lang').value = lang;
  refresh();
}

async function init() {
  lang = await getLang();
  applyDom(lang);
  $('lang').value = lang;
  $('lang').onchange = () => switchLang($('lang').value);

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
  $('openDebug').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });

  refresh();
  setInterval(refresh, 400);
}

init();
