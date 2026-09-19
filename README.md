# TV Scroll Capture

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
* **Vertical tracking** — the price window you start with is captured along the whole width
  (so levels, lines and drawings you could see stay continuous), and candles that leave it
  above or below are followed automatically; the final image grows in height, candles never
  change size. Zoom the price scale before starting to choose how much vertical room you want.
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
* Static overlays painted on the chart canvas (the TradingView logo, the "Replay" watermark)
  have no switch. The extension locates them from the first frames and cuts them out of every
  frame so the neighbouring frame supplies the real pixels underneath; a cut-out is kept only
  where nothing else covers that spot *and* candles lie under it, so no chart content is lost.
* Nothing leaves your machine: no network requests, the result is stored in IndexedDB.

## Development

Plain ES modules, no bundler. `docs/movement-spike.md` records the diagnosis of the v1.2
failure and the evidence behind the v1.3 design. Run `node --check *.js` before committing.

---
