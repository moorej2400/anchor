/**
 * End-to-end checks for the Anchor frontend, run against `VITE_IPC=mock`.
 *
 * These cover what jsdom structurally cannot: real layout, real hit-testing,
 * real paint timing, and a real xterm renderer. Two checks here exist because
 * unit tests passed while the UI was broken — see `hit-testable close
 * confirmation` and `background terminals are sized`.
 *
 * Each check returns `{ name, ok, detail }`. `detail` is printed on failure and
 * kept in the JSON report either way, so a regression arrives with evidence
 * rather than just a red cross.
 */
import { sleep } from "./driver.mjs";

/** Session ids seeded by src/ipc/mock.ts, with the title each one renders. */
const TITLES = {
  "w-claude": "refactor auth middleware",
  "w-copilot": "revert last 3 commits",
  "api-codex": "fix checkout.spec timers",
  "api-claude": "add /sessions pagination",
  "api-oc": "stripe webhook retries",
  "m-copilot": "expo build errors",
  "m-claude": "dark mode tokens",
};
const jsString = (value) => JSON.stringify(value);
const rowFor = (title) =>
  `[...document.querySelectorAll('.a-row')].find(e => e.textContent.includes(${jsString(title)}))`;
const tabFor = (title) =>
  `[...document.querySelectorAll('.a-tab')].find(e => e.textContent.includes(${jsString(title)}))`;

/** Slot geometry plus WebGL context health, per open terminal. */
const SLOT_PROBE = `[...document.querySelectorAll('.terminal-slot')].map(slot => {
  const box = slot.getBoundingClientRect();
  const screen = slot.querySelector('.xterm-screen');
  const canvases = [...slot.querySelectorAll('canvas')].map(c => {
    for (const kind of ['webgl2', 'webgl']) {
      const gl = c.getContext(kind);
      if (gl) return { kind, lost: gl.isContextLost() };
    }
    return { kind: '2d', lost: false };
  });
  return {
    id: slot.dataset.terminalSessionId,
    active: slot.dataset.terminalActive === 'true',
    box: { w: Math.round(box.width), h: Math.round(box.height) },
    screen: screen
      ? { w: Math.round(screen.getBoundingClientRect().width),
          h: Math.round(screen.getBoundingClientRect().height) }
      : null,
    canvases,
  };
})`;

/** Bring a saved session up so its terminal carries real output. */
async function resume(page, title) {
  await page.eval(`(() => { const r = ${rowFor(title)}; if (r) r.click(); return !!r; })()`);
  await sleep(150);
  await page.eval(
    `(() => { const b = [...document.querySelectorAll('button')]
       .find(x => x.textContent.includes('Resume session')); if (b) b.click(); return !!b; })()`,
  );
  await sleep(700); // the mock streams its banner over ~400ms
}

const select = (page, id) =>
  page.eval(`(() => { const t = ${tabFor(TITLES[id])}; if (t) t.click(); return !!t; })()`);

export async function runChecks(page, { screenshotsDir, save }) {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "  ok  " : "FAIL  "}${name}`);
    if (!ok) console.log(`        ${JSON.stringify(detail)}`);
    return ok;
  };

  for (const title of ["add /sessions pagination", "stripe webhook retries"]) {
    await resume(page, title);
  }

  const live = (await page.eval(SLOT_PROBE)).map((s) => s.id);
  record("live sessions own a terminal slot", live.length >= 3, { live });

  // --- distinct rendered content -------------------------------------------
  const frames = {};
  for (const id of live) {
    await select(page, id);
    await sleep(300);
    frames[id] = await page.screenshot();
  }
  const distinct = new Set(Object.values(frames)).size;
  record("each session renders distinct content", distinct === live.length, {
    sessions: live.length, distinct,
  });

  // --- REGRESSION: background terminals are sized --------------------------
  // A terminal in an unselected tab used to keep xterm's default 80x24 while
  // its pane was far wider, so its CLI wrapped output to the wrong width and
  // the tab looked mangled until a window resize reflowed it. Slots are laid
  // out identically, so every slot must measure close to its own box whether
  // or not it has ever been shown.
  const slots = await page.eval(SLOT_PROBE);
  const undersized = slots.filter((s) => !s.screen || s.screen.w < s.box.w * 0.8);
  record("background terminals are sized to their slot", undersized.length === 0, {
    undersized, slots,
  });

  const lostContexts = slots.filter((s) => s.canvases.some((c) => c.lost));
  record("no terminal has a lost WebGL context", lostContexts.length === 0, { lostContexts });

  // --- selection invariants + latency --------------------------------------
  await page.eval(`(() => {
    window.__lt = [];
    new PerformanceObserver(l => { for (const e of l.getEntries())
      window.__lt.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); })
      .observe({ type: 'longtask', buffered: true });
    document.addEventListener('click', () => { window.__clickAt = performance.now(); }, true);
    return true;
  })()`);

  const targets = live.slice(0, 3);
  const switchFailures = [];
  const latencies = [];
  for (let i = 0; i < 50; i++) {
    const id = targets[i % targets.length];
    // Alternate between the sidebar row and the tab. Match on title, never on
    // index: the sidebar lists every session grouped by folder, so its order
    // does not match slot order.
    const viaRow = i % 2 === 0;
    const spot = await page.clickElement(viaRow ? rowFor(TITLES[id]) : tabFor(TITLES[id]));
    if (!spot || !spot.hitsTarget) {
      switchFailures.push({ i, id, via: viaRow ? "row" : "tab", spot });
      continue;
    }
    const state = await page.eval(`(async () => {
      const t = await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))));
      const slots = [...document.querySelectorAll('.terminal-slot')];
      return {
        ms: +(t - window.__clickAt).toFixed(1),
        active: slots.filter(s => s.dataset.terminalActive === 'true').map(s => s.dataset.terminalSessionId),
        visible: slots.filter(s => getComputedStyle(s).visibility !== 'hidden').map(s => s.dataset.terminalSessionId),
        focusable: [...document.querySelectorAll('textarea.xterm-helper-textarea')]
          .filter(x => { x.focus(); return document.activeElement === x; }).length,
      };
    })()`);
    latencies.push(state.ms);
    const correct = state.active.length === 1 && state.active[0] === id
      && state.visible.length === 1 && state.visible[0] === id
      && state.focusable === 1;
    if (!correct) switchFailures.push({ i, id, via: viaRow ? "row" : "tab", ...state });
  }
  record("50 alternating selections keep one visible, focusable terminal",
    switchFailures.length === 0, { failures: switchFailures.slice(0, 5) });

  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const latency = { min: sorted[0], p50: pct(50), p95: pct(95), max: sorted[sorted.length - 1] };
  // The 100ms budget is asserted on p95, not on max. Each sample spans two
  // animation frames on a developer machine that is usually also running a
  // dev server and a compiler, so a single frame can slip past 100ms purely
  // from scheduling. The load-independent signal that the app itself is doing
  // slow work is the long-task check below, which is asserted at zero; the
  // ceiling on max is only here to catch a gross regression.
  record("input to visible terminal stays under 100ms (p95)",
    latency.p95 < 100 && latency.max < 250, latency);

  const longTasks = await page.eval("window.__lt");
  record("no main-thread long task over 50ms", longTasks.length === 0, { longTasks });

  // --- output buffered while a session is hidden ---------------------------
  await resume(page, "expo build errors");
  await page.eval(`(() => { const t = ${tabFor("refactor auth middleware")}; if (t) t.click(); return !!t; })()`);
  await sleep(1200); // the whole banner streams while that session is hidden
  const buffered = await page.eval(`(async () => {
    const t = ${tabFor("expo build errors")}; if (t) t.click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const slot = [...document.querySelectorAll('.terminal-slot')]
      .find(s => s.dataset.terminalSessionId === 'm-copilot');
    const rows = slot && slot.querySelector('.xterm-rows');
    const text = rows ? rows.innerText.replace(/\\s+/g, ' ') : '';
    return { first: text.includes('GitHub Copilot CLI'), last: text.includes('git reset --soft HEAD~3'),
             text: text.slice(0, 120) };
  })()`);
  record("output produced while hidden is complete on selection",
    buffered.first && buffered.last, buffered);

  // --- close: confirmation, hit-testability, removal latency ---------------
  const closeTarget = live[live.length - 1];
  await select(page, closeTarget);
  await sleep(200);
  const tabsBefore = await page.eval("document.querySelectorAll('.a-tab').length");
  const closeSpot = await page.clickElement(
    `(() => { const tab = ${tabFor(TITLES[closeTarget])};
       return tab && [...tab.querySelectorAll('button')].find(b => b.textContent.includes('\\u00d7')); })()`,
  );
  record("tab close control is hit-testable", !!closeSpot && closeSpot.hitsTarget, { closeSpot });
  await sleep(300);

  const dialog = await page.eval(`(() => {
    const d = document.querySelector('.a-confirm, .a-modal');
    return d ? { text: d.innerText.replace(/\\s+/g, ' ').slice(0, 120),
                 buttons: [...d.querySelectorAll('button')].map(b => b.textContent.trim()) } : null;
  })()`);
  record("closing a live session asks first", !!dialog, { dialog });

  if (dialog) {
    // REGRESSION: the first version of this prompt was a popover inside the tab
    // strip. It laid out correctly and every unit test passed, but `.tabstrip`
    // has overflow:auto so it was clipped, and elementFromPoint at the confirm
    // button returned `.xterm-screen`. Assert reachability, not just presence.
    const confirmSpot = await page.clickElement(
      `[...document.querySelectorAll('.a-confirm button, .a-modal button')]
         .find(b => !/cancel/i.test(b.textContent))`,
    );
    record("hit-testable close confirmation", !!confirmSpot && confirmSpot.hitsTarget, { confirmSpot });

    const removal = await page.eval(`(async () => {
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const n = document.querySelectorAll('.a-tab').length;
        if (n < ${tabsBefore}) return { ms: +(performance.now() - window.__clickAt).toFixed(1), tabs: n };
      }
      return { timedOut: true, tabs: document.querySelectorAll('.a-tab').length };
    })()`);
    record("tab is removed within 100ms of confirming",
      !removal.timedOut && removal.ms < 100, removal);

    // The window must stay usable while backend shutdown continues.
    const settings = await page.eval(`(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Settings'));
      if (b) b.click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return /General|Persistence|Appearance/.test(document.body.innerText);
    })()`);
    record("UI stays interactive while shutdown continues", settings === true, { settings });
  }

  // --- reopening a closed session keeps its provider id --------------------
  await page.eval(`(() => { const t = document.querySelector('.a-tab'); if (t) t.click(); return !!t; })()`);
  await sleep(200);
  const reopened = await page.eval(`(async () => {
    const r = ${rowFor(TITLES[closeTarget])}; if (!r) return { error: 'row missing' };
    r.click();
    await new Promise(x => setTimeout(x, 400));
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    const match = text.match(/session id ([0-9a-f-]+)/i);
    return { resumable: /READY TO RESUME/i.test(text), providerId: match ? match[1] : null };
  })()`);
  record("reopened session keeps its exact provider id",
    reopened.providerId === "e7f3-5540-2c19", { ...reopened, expected: "e7f3-5540-2c19" });

  // --- the `+` leads the strip and only the tabs scroll ---------------------
  // REGRESSION: the `+` used to trail the tabs, so it slid right with every new
  // session. It is now outside the scrollport, which is also what keeps the
  // scrollbar to the region the tabs occupy instead of the full strip width.
  // Assert what is under the pixels, not just where the boxes sit: a button can
  // be laid out perfectly and still be covered by a tab that eats its clicks.
  await page.eval(`(() => {
    const rows = [...document.querySelectorAll('.a-row')];
    for (const r of rows) r.click();
  })()`);
  await sleep(400);

  const PLUS_PROBE = `(() => {
    const strip = document.querySelector('.tabstrip');
    const scroll = document.querySelector('.tabstrip__scroll');
    const plus = document.querySelector('.tabstrip__new');
    if (!strip || !scroll || !plus) return { error: 'tab strip, scrollport or + missing' };
    const box = plus.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const scrollBox = scroll.getBoundingClientRect();
    const y = Math.round(box.top + box.height / 2);
    // No tab may occupy any column from the strip's left edge through the
    // button's right edge — that band belongs to the `+`, not the scrollport.
    let bleed = 0;
    for (let x = Math.round(stripBox.left) + 1; x < Math.round(box.right); x += 2) {
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('.a-tab')) bleed++;
    }
    return {
      tabs: document.querySelectorAll('.a-tab').length,
      left: Math.round(box.left),
      scrollable: Math.round(scroll.scrollWidth) > Math.round(scroll.clientWidth),
      // Gap between the button and where the tabs begin scrolling.
      gap: Math.round(scrollBox.left - box.right),
      // How far the scrollport reaches left of the strip's right edge; it must
      // start after the `+`, not span the whole strip.
      scrollLeftEdge: Math.round(scrollBox.left),
      stripLeftEdge: Math.round(stripBox.left),
      bleed,
    };
  })()`;

  const plusAtRest = await page.eval(PLUS_PROBE);
  const plusScrolled = await page.eval(`(async () => {
    const scroll = document.querySelector('.tabstrip__scroll');
    scroll.scrollLeft = scroll.scrollWidth;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return ${PLUS_PROBE};
  })()`);

  record("tab strip scrolls with every session open",
    plusAtRest.scrollable === true, plusAtRest);
  record("the + holds its place when the strip is scrolled",
    plusAtRest.left === plusScrolled.left,
    { atRest: plusAtRest.left, scrolled: plusScrolled.left });
  record("no tab shows through beside the +",
    plusAtRest.bleed === 0 && plusScrolled.bleed === 0,
    { atRest: plusAtRest.bleed, scrolled: plusScrolled.bleed });
  // The scrollport must begin after the button, so the scrollbar spans only
  // where tabs can actually scroll rather than running under the `+`.
  record("the tab scrollport starts after the +",
    plusAtRest.scrollLeftEdge > plusAtRest.stripLeftEdge
      && plusAtRest.gap >= 6,
    plusAtRest);

  const plusSpot = await page.clickElement("document.querySelector('.tabstrip__new')");
  record("the + is clickable over a scrolled strip",
    !!plusSpot && plusSpot.hitsTarget, { plusSpot });
  await sleep(300);
  const newSessionOpen = await page.eval(
    `!!document.querySelector('.a-modal, [role=dialog]')`,
  );
  record("clicking the + opens the new-session dialog", newSessionOpen === true,
    { newSessionOpen });
  if (save) {
    save(`${screenshotsDir}/tabstrip-plus.png`, await page.screenshot());
    for (const [id, data] of Object.entries(frames)) {
      save(`${screenshotsDir}/session-${id}.png`, data);
    }
  }
  return { results, latency, longTasks };
}
