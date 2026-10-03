# RC19 — Making the panel readable

The panel was accurate and hard to read. Every figure on it was correct, and a
reader still could not answer the two questions the panel exists for: *how close
am I to a fold*, and *is the cache doing its job*. This document records what was
wrong and what changed.

## 1. What was wrong

**Numbers in a unit nobody thinks in.** The formatter capped at `k`, so a
1,049,000-token window printed `1049k` and a 7,258,000-token total printed
`7258k`. Four digits of which the last three carry no decision-relevant
information, and two figures in that shape cannot be compared at a glance.

**The pressure figure had no reference point.** `Pressure 68k` next to
`Window 1049k` is two numbers that must be divided before they mean anything —
and dividing them is not even the interesting question. EF folds well before the
window is full, so what a reader needs is the *proportion*, not the raw pair.

**The one figure the design is for was missing.** EF's entire argument is that a
frozen prefix stays cached, so the cost of a long session grows much slower than
its token count. The panel compressed the provider's four-bucket split into a
single `Provider tokens 7258k` row, which cannot show cache reuse at all. A
reader could see the token total and not the thing that makes the total
affordable.

**The panel was English while the host was not.** A `zh` deployment showed a
Chinese harness with an English panel.

**A permanently-zero row trained the eye to skip it.** `Failed folds 0` rendered
unconditionally, which is exactly the row that must be noticed when it is not
zero.

## 2. What changed

### Numbers

`k` now steps to `M`, and keeps one decimal below 10M where the digit
distinguishes magnitudes:

| value | before | now |
| --- | --- | --- |
| 1,049,000 | `1049k` | `1.0M` |
| 7,258,000 | `7258k` | `7.3M` |
| 133,254 | `133k` | `133k` |
| 40,000 | `40k` | `40k` |

The exact figure stays reachable: every compacted row carries its unrounded value
as the element's `title`, so nothing is lost, only deferred.

### A proportion bar under the pressure rows

`占窗口 6.5%` — pressure over window, with a bar. This is the figure the panel was
missing that changes what a reader *does*. The percentage is the real value;
only the bar's fill is clamped, so a context that somehow exceeds its window
reads as over 100% rather than silently pinning at full.

Track and fill are **siblings**, not nested: `opacity` cascades, so a dimmed
track would dim the fill with it and the bar would read as uniformly faint. Both
inherit `currentColor`, so the bar follows the theme instead of hard-coding one.

### The cache-hit share, and the split it comes from

```
供应商用量（实测）
缓存命中        94.8%
未命中输入      378k
缓存读取        6.9M
输出            52k
```

The denominator is the **prompt side** (uncached + cache reads), matching DSH's
own `formatCacheHitPercent(cacheRead, total - output)` rather than inventing a
second convention for the same quantity.

When the prompt side is zero the share is omitted rather than printed as `0%`:
`0 / 0` is *unknown*, and `0%` would read as "caching is broken" instead of
"there is nothing to cache yet". Same rule as everywhere else on this surface.

### Locale

Copy is now a two-language table, and the active locale is read from the host at
**render** time. `zh-CN` and friends match on the primary subtag.

The translator is built from the **tab's** context, not the one the module
registered with. The registration ctx is the plugin's fiber and does not resolve
`locale`; the tab ctx is the one the sidebar hands down and the one that can.
That distinction was found by the locale test failing against a correct-looking
implementation.

A host that supplies its own `t` still wins, so the DSH-native idiom is not
precluded.

### Conditional rows

`Failed folds` renders only when non-zero.

## 3. Verification

Five tests in `tests/sidebar-panel-render.spec.ts`, and the formatter pair is
verified destructively: reverting `k` to the `k`-only rule fails both with
`expected ... to contain '1.3M'`.

- millions read as millions, and the `k` band keeps its decimal;
- the cache-hit share is shown **with** the split it comes from — a share alone
  cannot be checked;
- a zero prompt side yields no share, and no `NaN`;
- the occupancy proportion appears;
- `zh-CN` renders Chinese and no English section title; a deployment with no
  locale service renders English and no raw keys.

Full suite: **755 passed, 23 skipped**.

Observed live, `zh` deployment, `economy` tier:

```
当前上下文
压力            68k tokens
窗口            1.0M tokens
占窗口 6.5%     ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
...
会话
成本（估算）    —
无价目          opencode-zen/space-bunny-free
供应商用量（实测）
缓存命中        94.8%
未命中输入      378k
缓存读取        6.9M
输出            52k
```

## 4. Lesson

Accuracy and legibility are separate properties, and this panel had only the
first. Every figure was right; the reading was still not possible, because the
panel reported *measurements* where it needed to report *proportions*, in units
the reader does not use, in a language they did not choose.

The cache-hit row is the sharpest case. The panel had the data all along — the
four buckets were in the projection it already read — and it spent the space on
a single lumped total that answers no question the design raises. **A figure that
is available is not the same as a figure that is shown**, and the gap is invisible
from the host side, where the projection looks complete.
