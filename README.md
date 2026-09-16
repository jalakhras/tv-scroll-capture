# TV Scroll Capture

**English** · [العربية](#العربية)

A Chrome extension (Manifest V3) that captures an **extended screenshot of a TradingView chart**
that is wider (and taller) than the screen, while keeping every candle at its exact on-screen
pixel size. The UI is bilingual (English / Arabic, RTL).

## How it works (v1.3)

On `tradingview.com/chart` the extension drives the chart through TradingView's own page API
(`window.TradingViewApi`): it scrolls by whole bars, moves the price window by exact pixel
amounts to follow candles that leave the pane, turns Auto Scale off, hides the live price
line / crosshair / event markers / Volume overlay for the duration of the capture, and restores
everything afterwards. Every frame is still verified by image matching before it is stitched;
when a frame cannot be verified the capture stops instead of guessing (an incomplete image is
better than a wrong one). A CDP mouse-drag fallback is used on pages without the API.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin the icon. Open a chart on tradingview.com and click the icon.

## Use

* **Auto scroll** — pick the direction (into the past / toward present), the number of steps
  and the step length. The extension scrolls, captures and stitches; it stops exactly at the
  first or last bar, at Chrome's canvas limit (32000 px), or on the first frame it cannot verify.
  Recommended workflow for a whole history: scroll the chart manually to the oldest point you
  want, then run **toward present** with a large number of steps — it ends by itself at the
  last candle.
* **Manual capture** — press start, then move the chart yourself (arrow keys work best);
  press the button again or `Alt+Shift+S` to stop and save.
* **Vertical tracking** — candles that leave the pane top/bottom are followed automatically;
  the final image grows in height, candles never change size.
* **Debug mode** — saves every raw frame and a step log; open the debug page and export JSON
  when reporting a problem.
* **Language** — the selector in the popup header switches the whole UI (popup, result and
  debug pages, status messages) between Arabic and English.

Keep the Chrome window visible while capturing: a hidden or fully covered window stops
repainting and the capture pauses with a warning.

## Notes

* Chrome shows the “TV Scroll Capture started debugging this browser” bar while a capture runs;
  the extension uses the DevTools protocol for screenshots. Closing the bar stops the capture
  and keeps what was captured.
* The TradingView logo watermark is drawn on the chart canvas and has no switch. The extension
  locates it from the first frames and cuts it out of every frame so the neighbouring frame
  supplies the real pixels underneath; a cut-out is kept only where nothing else covers that
  spot *and* candles lie under the logo, so no chart content is ever lost.
* Nothing leaves your machine: no network requests, the result is stored in IndexedDB.

## Development

Plain ES modules, no bundler. `SPEC.md` (Arabic) is the requirements document;
`docs/movement-spike.md` records the diagnosis of the v1.2 failure and the evidence behind
the v1.3 design. Run `node --check *.js` before committing.

---

## العربية

إضافة Chrome (Manifest V3) تلتقط **لقطة شاشة ممتدّة لشارت TradingView** أطول من الشاشة
عرضاً وارتفاعاً، مع الحفاظ على حجم كل شمعة بالبكسل كما تظهر على الشاشة. الواجهة ثنائية اللغة
(عربية RTL / إنجليزية).

## طريقة العمل (v1.3)

على `tradingview.com/chart` تتحكم الإضافة بالشارت عبر واجهة TradingView البرمجية داخل الصفحة
(`window.TradingViewApi`): تمرّر بعدد شموع صحيح، وتحرّك النافذة السعرية بمقدار بكسلات محدّد
لتتبّع الشموع الخارجة من اللوحة، وتطفئ Auto Scale، وتخفي خط السعر الحي والـ crosshair وعلامات
الأحداث وهيستوغرام الحجم طوال الالتقاط، ثم تعيد كل شيء كما كان. يُتحقَّق من كل إطار بمطابقة
الصور قبل دمجه؛ وإذا تعذّر التحقق يتوقف الالتقاط بدل التخمين (صورة ناقصة أفضل من صورة خاطئة).
يُستخدم السحب بالماوس عبر CDP كبديل احتياطي في الصفحات التي لا تتوفر فيها الواجهة.

## التثبيت

1. افتح `chrome://extensions` وفعّل **Developer mode**.
2. اضغط **Load unpacked** واختر هذا المجلد.
3. ثبّت الأيقونة. افتح شارت على tradingview.com ثم اضغط الأيقونة.

## الاستخدام

* **التمرير الآلي** — اختر الاتجاه (نحو الماضي / نحو الحاضر) وعدد الخطوات وطول الخطوة.
  تمرّر الإضافة وتلتقط وتدمج، وتتوقف بدقة عند أول شمعة أو آخرها، أو عند حد Chrome (32000px)،
  أو عند أول إطار يتعذّر التحقق منه. الطريقة الموصى بها لتاريخ كامل: حرّك الشارت يدوياً إلى أقدم
  نقطة تريدها، ثم شغّل **نحو الحاضر** بعدد خطوات كبير — يتوقف وحده عند آخر شمعة.
* **الالتقاط اليدوي** — اضغط البدء ثم حرّك الشارت بنفسك (الأسهم أفضل)، وللإيقاف أعد الضغط
  أو `Alt+Shift+S`.
* **التتبّع العمودي** — الشموع الخارجة أعلى أو أسفل اللوحة تُتابَع تلقائياً؛ الصورة تكبر
  ارتفاعاً ولا يتغير حجم الشموع.
* **وضع التشخيص** — يحفظ كل إطار خام وسجل الخطوات؛ افتح صفحة التشخيص وصدّر JSON عند
  الإبلاغ عن مشكلة.
* **اللغة** — القائمة في رأس النافذة تبدّل كل الواجهة (النافذة، صفحة النتيجة، صفحة
  التشخيص، رسائل الحالة) بين العربية والإنجليزية.

أبقِ نافذة Chrome ظاهرة أثناء الالتقاط: النافذة المخفية أو المغطاة بالكامل تتوقف عن إعادة
الرسم فيتوقف الالتقاط مع تحذير.

## ملاحظات

* يظهر شريط «TV Scroll Capture بدأ تصحيح هذا المتصفح» أثناء الالتقاط لأن الإضافة تستخدم
  بروتوكول DevTools للقطات. إغلاقه يوقف الالتقاط ويحفظ ما التُقط.
* شعار TradingView مرسوم على canvas الشارت ولا مفتاح لإخفائه. تحدّد الإضافة موضعه من الإطارات
  الأولى وتقصّه من كل إطار ليملأ الإطار المجاور ما تحته بالمحتوى الحقيقي؛ ولا تُبقي قصاصته إلا حيث
  لا يغطي المكان إطار آخر **و**توجد شموع تحت الشعار، فلا يُفقد أي محتوى.
* لا يغادر شيء جهازك: لا طلبات شبكة، والنتيجة تُحفظ في IndexedDB.

## التطوير

وحدات ES عادية بلا bundler. `SPEC.md` هو وثيقة المتطلبات، و`docs/movement-spike.md` يوثّق
تشخيص فشل v1.2 والأدلة وراء تصميم v1.3. شغّل `node --check *.js` قبل كل commit.
