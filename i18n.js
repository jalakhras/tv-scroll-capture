// Shared bilingual message catalog (Arabic / English).
// Used by the popup, the result page and the background service worker.
// Keys are stable identifiers; the background stores keys + vars (not text)
// so the UI can render them in whichever language is active.

export const LANGS = ['ar', 'en'];
export const DEFAULT_LANG = 'ar';

export const MESSAGES = {
  ar: {
    // Generic
    appTitle: 'لقطة شارت ممتدّة',
    langLabel: 'اللغة',
    langAr: 'العربية',
    langEn: 'English',

    // Popup
    preTitle: 'قبل البدء:',
    preBody: 'اخرج من وضع Replay، وأخفِ الرسومات اليدوية، واختر أداة المؤشّر العادية، ولا تبدّل التبويب أثناء الالتقاط.',
    notTv: 'افتح شارت على tradingview.com ثم أعد فتح الإضافة.',
    autoTitle: 'التمرير الآلي',
    direction: 'الاتجاه',
    dirLeft: 'نحو الماضي ←',
    dirRight: 'نحو الحاضر →',
    steps: 'عدد الخطوات',
    stepPct: 'طول الخطوة (% من العرض)',
    settleMs: 'انتظار بعد كل خطوة (ms)',
    startAuto: 'ابدأ التمرير الآلي',
    manualTitle: 'الالتقاط اليدوي',
    intervalMs: 'فاصل الالتقاط (ms)',
    startManual: 'ابدأ ثم حرّك الشارت بنفسك',
    manualHint1: 'أفضل نتيجة: انقر على الشارت، أبعد الماوس عنه، ثم استخدم الأسهم ← →. للإيقاف أعد فتح الإضافة أو اضغط',
    manualHint2: '.',
    autoScaleOff: 'إيقاف Auto Scale تلقائياً قبل البدء',
    verticalTrack: 'تتبّع الشموع الخارجة أعلى أو أسفل اللوحة',
    maxVert: 'أقصى تحريكات عمودية لكل خطوة',
    hideOverlays: 'إخفاء الأسطورة والأزرار العائمة',
    includeAxis: 'إضافة محور السعر في الطرف',
    debug: 'وضع التشخيص (حفظ الإطارات الخام والسجل)',
    openDebug: 'فتح صفحة التشخيص',
    stop: 'أوقف واحفظ الصورة',
    startFailed: 'تعذّر البدء',
    alreadyRunning: 'يوجد التقاط قيد التشغيل',

    // Result page
    resultTitle: 'نتيجة الالتقاط',
    resultHeading: 'لقطة الشارت الممتدّة',
    fit: 'احتواء في الشاشة',
    native: 'الحجم الأصلي',
    copy: 'نسخ الصورة',
    copied: 'تم النسخ',
    copyFailed: 'تعذّر النسخ',
    download: 'تنزيل PNG',
    imgAlt: 'لقطة الشارت',
    empty: 'لا توجد نتيجة محفوظة بعد. شغّل الالتقاط من أيقونة الإضافة.',
    meta: '{w}×{h}px، {frames} مقطع، {mode}',
    modeAuto: 'آلي',
    modeManual: 'يدوي',

    // Debug page
    debugTitle: 'تشخيص الالتقاط',
    debugHeading: 'سجل التشخيص',
    debugEmpty: 'لا يوجد سجل تشخيص. فعّل «وضع التشخيص» في النافذة ثم شغّل التقاطاً.',
    exportJson: 'تصدير JSON',
    debugFrames: 'الإطارات',
    debugLog: 'السجل',
    debugLayout: 'التخطيط المكتشف',

    // Background status
    stReady: 'جاهز',
    stLayout: 'تحليل تخطيط الشارت…',
    stAutoScale: 'إيقاف Auto Scale…',
    stVertical: 'تتبّع عمودي {arrow}…',
    stStep: 'خطوة {i} من {n}…',
    stManual: 'التقاط يدوي: حرّك الشارت الآن ({frames} مقطع)',
    stCompose: 'دمج الصورة…',
    stDone: 'تم: {frames} مقطع، {w}×{h}px',
    stError: 'خطأ: {msg}',
    stComposeFailed: 'فشل الدمج: {msg}',

    // Background warnings / errors
    errNoChart: 'لم يتم العثور على منطقة الشارت في الصفحة',
    wNoStart: 'لم أجد مساحة فارغة لبدء السحب، فاستُخدم منتصف الشارت. إن تحرّكت رسمة بدل الشارت فأخفِ الرسومات.',
    wCap: 'بلغت الصورة الحد الأقصى للحجم الذي يسمح به Chrome، تم الإيقاف عند هذه النقطة.',
    wTall: 'بعض الشموع أو الحركات أطول من ارتفاع اللوحة في لقطة واحدة. صغّر المقياس السعري قليلاً إن ظهرت فجوات.',
    wVertWeak: 'تتبّع عمودي: تطابق ضعيف ({pct}%)، تم تجاهل هذه اللقطة وإرجاع الشارت لمكانه.',
    wMaxVert: 'بلغ التتبّع العمودي حدّه في بعض المواضع. زد "أقصى تحريكات عمودية" أو صغّر المقياس السعري.',
    wScale: 'المقياس السعري تغيّر مع الحركة الأفقية، فتم الإيقاف لتجنّب دمج خاطئ. تأكد أن زر A مطفأ، وأن خيار Lock price to bar ratio غير مفعّل.',
    wScaleSoft: 'محور السعر تغيّر قليلاً بعد أول تحريك، لكن الشموع تطابقت. راجع الصورة للتأكد.',
    wStepWeak: 'خطوة {i}: تطابق ضعيف ({pct}%)، تم إيقاف الالتقاط عند هذه النقطة.',
    wStepMid: 'خطوة {i}: تطابق متوسط ({pct}%)، راجع موضع الوصل.',
    wStall: 'خطوة {i}: الشارت لم يتحرك (الإزاحة الصفرية تطابق {pct}%). السحب لا يصل إلى الشارت، راجع صفحة التشخيص.',
    wEnd: 'الشارت توقّف عن الحركة، غالباً وصلنا لنهاية البيانات المتاحة.',
    wManualSkip: 'تم تجاهل إطارات لم يمكن مطابقتها. حرّك الشارت أبطأ، ولا تغيّر الزوم أثناء الالتقاط.',
    wDetached: 'تم فصل الالتقاط (أُغلق شريط التصحيح أو التبويب).',
    wStripOnly: 'بعض المقاطع تحقّقت إزاحتها من محور الوقت فقط (لا شموع كافية في اللوحة). راجع مواضع الوصل.',
    wEndReached: 'وصلنا إلى أول البيانات المتاحة.',
    wSymbolChanged: 'تغيّر الرمز أو الإطار الزمني أثناء الالتقاط ({from} → {to})، تم الإيقاف.',
    wNoPaint: 'الصفحة لا تُعيد الرسم (النافذة مخفية أو مغطاة بنافذة أخرى). أبقِ نافذة Chrome ظاهرة أثناء الالتقاط.',
    wError: 'خطأ: {msg}',
  },

  en: {
    // Generic
    appTitle: 'Extended chart capture',
    langLabel: 'Language',
    langAr: 'العربية',
    langEn: 'English',

    // Popup
    preTitle: 'Before you start:',
    preBody: 'Exit Replay mode, hide manual drawings, select the regular cursor tool, and do not switch tabs while capturing.',
    notTv: 'Open a chart on tradingview.com, then reopen the extension.',
    autoTitle: 'Auto scroll',
    direction: 'Direction',
    dirLeft: '← Into the past',
    dirRight: 'Toward present →',
    steps: 'Number of steps',
    stepPct: 'Step length (% of width)',
    settleMs: 'Wait after each step (ms)',
    startAuto: 'Start auto scroll',
    manualTitle: 'Manual capture',
    intervalMs: 'Capture interval (ms)',
    startManual: 'Start, then move the chart yourself',
    manualHint1: 'Best result: click the chart, move the mouse away, then use the ← → arrow keys. To stop, reopen the extension or press',
    manualHint2: '.',
    autoScaleOff: 'Turn Auto Scale off automatically before starting',
    verticalTrack: 'Follow candles that leave the pane top or bottom',
    maxVert: 'Max vertical moves per step',
    hideOverlays: 'Hide legend and floating buttons',
    includeAxis: 'Append the price axis on the side',
    debug: 'Debug mode (save raw frames and log)',
    openDebug: 'Open debug page',
    stop: 'Stop and save image',
    startFailed: 'Could not start',
    alreadyRunning: 'A capture is already running',

    // Result page
    resultTitle: 'Capture result',
    resultHeading: 'Extended chart capture',
    fit: 'Fit to screen',
    native: 'Native size',
    copy: 'Copy image',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    download: 'Download PNG',
    imgAlt: 'Chart capture',
    empty: 'No saved result yet. Run a capture from the extension icon.',
    meta: '{w}×{h}px, {frames} frames, {mode}',
    modeAuto: 'auto',
    modeManual: 'manual',

    // Debug page
    debugTitle: 'Capture diagnostics',
    debugHeading: 'Diagnostics log',
    debugEmpty: 'No diagnostics log. Enable "Debug mode" in the popup, then run a capture.',
    exportJson: 'Export JSON',
    debugFrames: 'Frames',
    debugLog: 'Log',
    debugLayout: 'Detected layout',

    // Background status
    stReady: 'Ready',
    stLayout: 'Analyzing chart layout…',
    stAutoScale: 'Turning Auto Scale off…',
    stVertical: 'Vertical tracking {arrow}…',
    stStep: 'Step {i} of {n}…',
    stManual: 'Manual capture: move the chart now ({frames} frames)',
    stCompose: 'Composing image…',
    stDone: 'Done: {frames} frames, {w}×{h}px',
    stError: 'Error: {msg}',
    stComposeFailed: 'Compose failed: {msg}',

    // Background warnings / errors
    errNoChart: 'Could not find the chart area on the page',
    wNoStart: 'No empty area was found to start the drag, so the chart center was used. If a drawing moved instead of the chart, hide your drawings.',
    wCap: 'The image reached the maximum size Chrome allows; capture stopped at this point.',
    wTall: 'Some candles or moves are taller than the pane in a single shot. Shrink the price scale slightly if gaps appear.',
    wVertWeak: 'Vertical tracking: weak match ({pct}%); this shot was discarded and the chart was moved back.',
    wMaxVert: 'Vertical tracking hit its limit in some places. Increase "Max vertical moves" or shrink the price scale.',
    wScale: 'The price scale changed during horizontal movement, so capture stopped to avoid a bad stitch. Make sure the A button is off and "Lock price to bar ratio" is disabled.',
    wScaleSoft: 'The price axis changed slightly after the first move, but the candles matched. Check the image.',
    wStepWeak: 'Step {i}: weak match ({pct}%); capture stopped at this point.',
    wStepMid: 'Step {i}: medium match ({pct}%); check the seam position.',
    wStall: 'Step {i}: the chart did not move (zero-shift match {pct}%). The drag is not reaching the chart; see the debug page.',
    wEnd: 'The chart stopped moving; the end of available data was probably reached.',
    wManualSkip: 'Frames that could not be matched were skipped. Move the chart more slowly and do not change zoom while capturing.',
    wDetached: 'Capture was detached (the debugger bar or the tab was closed).',
    wStripOnly: 'Some frames were verified from the time axis only (not enough candles in the pane). Check the seams.',
    wEndReached: 'Reached the beginning of the available data.',
    wSymbolChanged: 'The symbol or timeframe changed during capture ({from} → {to}); capture stopped.',
    wNoPaint: 'The page is not repainting (window hidden or covered by another window). Keep the Chrome window visible while capturing.',
    wError: 'Error: {msg}',
  },
};

export function isRtl(lang) {
  return lang === 'ar';
}

/** Resolve the active language: stored preference, else browser UI language, else default. */
export async function getLang() {
  try {
    const { lang } = await chrome.storage.local.get('lang');
    if (LANGS.includes(lang)) return lang;
  } catch {}
  const ui = (chrome.i18n?.getUILanguage?.() || globalThis.navigator?.language || '').toLowerCase();
  if (ui.startsWith('ar')) return 'ar';
  if (ui.startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

export async function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  await chrome.storage.local.set({ lang });
}

/** Translate a key with {placeholders}. Falls back to English, then to the key itself. */
export function t(lang, key, vars) {
  const s = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Render a stored message: either { key, vars } or a plain string (legacy). */
export function tm(lang, msg) {
  if (msg && typeof msg === 'object' && msg.key) return t(lang, msg.key, msg.vars);
  return String(msg ?? '');
}

/**
 * Apply translations to the DOM. Elements opt in with:
 *   data-i18n="key"        -> textContent
 *   data-i18n-title="key"  -> title attribute
 *   data-i18n-alt="key"    -> alt attribute
 */
export function applyDom(lang, root = document) {
  const doc = root.ownerDocument || root;
  doc.documentElement.lang = lang;
  doc.documentElement.dir = isRtl(lang) ? 'rtl' : 'ltr';
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(lang, el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(lang, el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-alt]')) el.alt = t(lang, el.dataset.i18nAlt);
  const titleEl = doc.querySelector('title[data-i18n]');
  if (titleEl) doc.title = t(lang, titleEl.dataset.i18n);
}
