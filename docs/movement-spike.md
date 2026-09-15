# Movement spike — why v1.2 failed on real TradingView and what v1.3 does instead

Evidence gathered on 2026-09-16 against the live `https://www.tradingview.com/chart/` page
(Chrome 152, anonymous session, AAPL 1D, light theme, Volume overlay on). All numbers come
from the extension's own debug mode (`debug.html`) and from CDP experiments run outside it.

## Findings (SPEC §6 hypotheses)

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | CDP drags never reach the chart | **False** | `document.elementFromPoint` at the drag start is the pane `<canvas>` (`pointer-events: auto`); a 560 px CDP drag moved the time scale by 86.7 bars (520 px). The first `mouseMoved` after `mousePressed` is swallowed as the drag threshold, so drags are consistently one step (40 px) short. |
| H2 | Crosshair stays visible | **True** | Crosshair lines and axis labels follow the *physical* mouse; `parkMouse(2,2)` does not remove them. |
| H3 | The click changes chart state | Not observed | — |
| H4 | Layout detection is wrong | **True (partly)** | `chrome.debugger.attach` shows an infobar that pushes the page down 56 px *after* the layout was measured; v1.2 captured a stale rectangle. TradingView also resizes its canvases a few hundred ms later. |
| — | Auto Scale nudge | **Does nothing** | A vertical drag with Auto Scale on leaves `isAutoScale()` true and the price range unchanged. With Auto Scale on, every horizontal move rescales prices → candles change height → "weak match 93–98 %". This is the real cause of the v1.2 numbers. |

## Why the match score was bad even when the shift was right

Diffing two frames at the correct shift showed that the candles matched and the mismatch came from
(a) horizontal grid lines and the live price line (dotted; the dot phase never lines up),
(b) the TradingView logo and axis labels (static), and
(c) the Volume histogram, which is rescaled to the visible bars on every scroll.

## Alternatives evaluated (SPEC §7, phase 1)

| # | Method | Result |
|---|---|---|
| A | `window.TradingViewApi` (MAIN world) | **Adopted.** `activeChart().scrollChartByBar(n)` moves exactly `n × barSpacing` CSS px, synchronously. `getMainSourcePriceScale().setAutoScale(false)` / `setVisiblePriceRange()` give exact vertical moves (`priceToCoordinate` confirms ±0.1 px). `chartModel().mainSeries().bars().valueAt(i)` gives OHLC per bar, so clipped candles are detected from data, not from edge ink. `applyOverrides()` hides price line / crosshair labels / event markers; `selectLineTool('arrow_cursor')` removes the crosshair; overlay studies on their own scale (Volume) are hidden with `setVisible(false)`. Everything is restored at the end. |
| B | Keyboard arrows | Not needed once A worked. |
| C | Improved CDP drag | Kept only as the fallback when `TradingViewApi` is absent. Not fixed further. |
| D | `Emulation.setDeviceMetricsOverride` to a huge viewport | Not evaluated (A is deterministic and keeps the real viewport). |

## Matching changes that the evidence required

* **Static-overlay mask** — pixels that are identical ink in both frames at zero shift (grid, price line, logo, labels) are excluded from the score.
* **Trimmed row score** — the worst rows (up to 50 % of the ink) are dropped so a rescaled overlay cannot hide a correct match; a wrong shift is still bad in every row.
* **Zero-shift test** — a near-perfect match at (0, 0) means the chart did not move / did not repaint (reported as a stall, not as a bad stitch).
* **Time-axis witness** — for horizontal steps the date-label strip is matched separately; it is immune to the price window.
* **Scale check via API** — the price *span* before/after the first step, instead of comparing axis pixels (the last-price label changes them).

## Things that bit during testing

* `requestAnimationFrame` does not run while the Chrome window is hidden or fully covered by another window; the chart then never repaints after an API move and the screenshot is stale. The extension now waits for a frame and warns (`wNoPaint`).
* `series.priceRange()` takes `{startTimePoint, endTimePoint}` — passing bar indices silently returns the range of *all* loaded data.
* Volume bars made the pane matcher report 562/566 px for a 558 px move; with Volume hidden the API shift is exact.
* A click on the watchlist while a capture runs switches the symbol. The extension now stops with `wSymbolChanged`.
* The TradingView logo watermark is painted on the canvas and has no override; it repeats at the bottom-left of every vertical window (known limitation).

## Follow-up (v1.3.1, owner's chart: dark theme, indicator with shape labels, Windows 125 % scaling)

Reproduced with `--force-device-scale-factor=1.25`, dark theme and *Pivot Points High Low*
(labels above/below bars). Two independent failures, both fixed:

* **`setVisiblePriceRange()` pads the range with the scale margins.** Studies that draw labels
  request top/bottom margins; the API then treats the requested range as the *data* range and
  the visible span grows (~12 %), i.e. every vertical move changed the px-per-price ratio and
  the next horizontal step could not match. `setVisibleExact()` now measures the padding and
  asks for the range that yields the target exactly (2 iterations); restore uses it too.
* **Fractional devicePixelRatio snaps candle edges differently per frame.** At DPR 1.25 candle
  bodies were 5 device px wide in one frame and 6 in the next, so strict ink masks disagreed
  along every edge even at the correct shift (err 0.25 vs threshold 0.15). Full-resolution
  matching now tolerates 1 px (3×3 neighbourhood); because that flattens the score over a
  ±1 px plateau, the strict score breaks the tie among the plateau candidates (otherwise the
  search drifted 2 px). Quarter-scale search is unchanged.

Result: 6 steps / 10 frames / 5705×1175 px without warnings on the dark DPR-1.25 chart, and
the DPR-1 light chart still matches exactly (558/558, −327/−327).
