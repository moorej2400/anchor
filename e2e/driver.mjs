/**
 * Minimal Chrome DevTools Protocol driver for the end-to-end checks.
 *
 * Deliberately dependency-free: Node's global WebSocket and fetch are enough,
 * so `npm run e2e` needs nothing installed beyond Chrome itself.
 *
 * Chrome runs headless on a throwaway profile. That matters for more than
 * isolation: the page reports `visibilityState === "visible"`, so
 * `requestAnimationFrame` fires, xterm's renderer actually draws, and the Event
 * Timing API can report real input-to-paint. A background or hidden tab paints
 * nothing and silently stalls any rAF-based measurement.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeBinary() {
  const override = process.env.CHROME_PATH;
  if (override) return override;
  for (const path of CHROME_CANDIDATES) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    "no Chrome found; set CHROME_PATH to a Chrome or Chromium binary",
  );
}

export async function launchBrowser({ port = 9333, width = 1440, height = 900 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "anchor-e2e-"));
  const chrome = spawn(chromeBinary(), [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // swiftshader gives a real WebGL implementation, so the xterm WebGL
    // renderer takes the same code path it does on a user's machine.
    "--use-gl=swiftshader",
    `--window-size=${width},${height}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  if (!wsUrl) {
    chrome.kill("SIGTERM");
    throw new Error("Chrome DevTools endpoint never came up");
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("could not attach to Chrome"));
  });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = message.id && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: target.id, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  return {
    send: (method, params) => send(method, params, sessionId),

    /**
     * Evaluate in the page, awaiting a returned promise and unwrapping errors.
     *
     * This runs `Runtime.evaluate` over the debugging protocol — that is what a
     * browser driver is. The expressions come from this repo's own check files,
     * never from user input or page content, and the target is a throwaway
     * headless profile pointed at a local dev server.
     */
    async eval(expression) {
      const result = await send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text;
        throw new Error(`page eval failed: ${String(detail).slice(0, 400)}`);
      }
      return result.result.value;
    },

    /** Navigate and wait for the app to mount, tolerating the context teardown. */
    async open(url, readyExpression) {
      await send("Page.navigate", { url }, sessionId);
      for (let i = 0; ; i++) {
        try {
          await this.eval("document.readyState");
          break;
        } catch (error) {
          if (i > 60) throw error;
          await sleep(250);
        }
      }
      await this.eval(`(async()=>{
        for (let i = 0; i < 200; i++) {
          if (${readyExpression}) return true;
          await new Promise(r => setTimeout(r, 250));
        }
        throw new Error('app never became ready; body=' + document.body.innerText.slice(0, 200));
      })()`);
    },

    /**
     * Click with a real trusted input event at an element's centre.
     *
     * Returns what `elementFromPoint` found there. Callers should assert that
     * it is the intended target: a control can be laid out perfectly and still
     * be unreachable because something overlaps it or an ancestor clips it,
     * which is the class of bug this harness exists to catch.
     */
    async clickElement(selectorExpression) {
      const spot = await this.eval(`(async()=>{
        const el = ${selectorExpression};
        if (!el) return null;
        el.scrollIntoView({ block: 'nearest', inline: 'center' });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rect = el.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          x, y,
          onScreen: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
          hitsTarget: !!hit && (hit === el || el.contains(hit)),
          hitTag: hit && hit.tagName,
          hitClass: hit && String(hit.className),
        };
      })()`);
      if (!spot) return null;
      if (spot.onScreen) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send("Input.dispatchMouseEvent",
            { type, x: spot.x, y: spot.y, button: "left", clickCount: 1 }, sessionId);
        }
      }
      return spot;
    },

    async screenshot() {
      const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      return data;
    },

    async close() {
      try { ws.close(); } catch { /* already gone */ }
      // Kill only the process we spawned, never a broad pkill: the developer
      // running this almost certainly has their own Chrome open.
      try { chrome.kill("SIGTERM"); } catch { /* already gone */ }
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
