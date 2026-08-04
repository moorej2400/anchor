# End-to-end checks

```bash
npm run e2e
```

Starts its own Vite server in mock-IPC mode on a free port, drives a throwaway
headless Chrome over the DevTools Protocol, prints a pass/fail summary, and
exits non-zero on failure. Nothing to set up, nothing left running. Screenshots
and a JSON report land in `e2e/out/` (git-ignored).

Requires Chrome or Chromium. Set `CHROME_PATH` if it is somewhere unusual.

## Why this exists alongside `npm test`

The Vitest suite runs in jsdom, which has **no layout, no hit-testing, and no
paint**. That is fine for logic and wiring, and it is structurally blind to a
whole class of UI bug. Two real ones shipped past a green unit suite:

- **A confirmation dialog nobody could click.** It was a popover inside the tab
  strip. It rendered, its markup was right, and every unit test passed — but
  `.tabstrip` has `overflow: auto`, so it was clipped, and `elementFromPoint` at
  the confirm button returned `.xterm-screen`. Now covered by *hit-testable
  close confirmation*, which asserts the click actually lands on the button.

- **Terminals in unselected tabs stuck at 80×24.** Only the selected slot was
  ever fitted, so a background session's PTY kept the wrong width and its CLI
  wrapped output for 80 columns while the pane was ~133 wide. The tab looked
  mangled until a window resize reflowed it. Now covered by *background
  terminals are sized to their slot*, which measures every slot including the
  hidden ones.

The rule of thumb: if a bug involves **layout, hit-testing, paint timing, or
canvas rendering**, it belongs here. If it involves state, ordering, or IPC, a
unit test is faster and better.

## What it covers

Terminal deck invariants across 50 alternating sidebar/tab selections (exactly
one active slot, one visible slot, one focusable input surface), input-to-paint
latency, main-thread long tasks, output buffered while a session is hidden, the
close confirmation and its removal latency, that a reopened session keeps its
exact saved provider ID, and that the tab strip's `+` stays pinned to the left
and reachable with every session open and the strip scrolled to its end.

## Notes for extending it

- **Match elements by their text, never by index.** The sidebar lists every
  session grouped by folder, so its order does not match tab or slot order.
- **Use `page.clickElement()` and check `hitsTarget`.** It dispatches a real
  trusted mouse event and reports what `elementFromPoint` found. Asserting an
  element exists is not the same as asserting a user can click it.
- **Measure from `window.__clickAt`**, the in-page click timestamp. Timing from
  the driver instead spans two CDP round trips and inflated one measurement
  from 41 ms to 150 ms.
- **Latency budgets are asserted on p95, not max.** A single frame can slip on a
  loaded machine. Zero long tasks is the load-independent signal.
- The mock backend lives in `src/ipc/mock.ts`; seeded session IDs and titles are
  mirrored in `checks.mjs`. Keep them in step, and keep the mock faithful to
  `docs/SPEC.md` — a mock that lies makes this suite lie.
