#!/usr/bin/env node
/**
 * `npm run e2e` — end-to-end checks against the real frontend in a real browser.
 *
 * Self-contained: starts its own Vite server in mock-IPC mode on a free port,
 * drives a throwaway headless Chrome, prints a pass/fail summary, and exits
 * non-zero on failure. Nothing to set up and nothing left running.
 *
 * See e2e/README.md for why this exists alongside the Vitest suite.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, sleep } from "./driver.mjs";
import { runChecks } from "./checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outDir = join(here, "out");

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function startDevServer(port) {
  const vite = spawn(
    process.execPath,
    // Bind IPv4 explicitly: vite's default `localhost` can resolve to ::1 only,
    // and then the readiness probe and Chrome both fail to reach it.
    [join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
      "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: repoRoot, env: { ...process.env, VITE_IPC: "mock" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  vite.stdout.on("data", (d) => { log += d; });
  vite.stderr.on("data", (d) => { log += d; });

  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return vite;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  vite.kill("SIGTERM");
  throw new Error(`vite never came up on ${port}:\n${log.slice(-800)}`);
}

let vite;
let browser;
let exitCode = 1;
try {
  mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  console.log(`\nAnchor end-to-end checks (mock IPC on :${port})\n`);
  vite = await startDevServer(port);

  browser = await launchBrowser({ port: await freePort() });
  await browser.open(
    `http://127.0.0.1:${port}/`,
    "document.querySelectorAll('.terminal-slot').length >= 3",
  );

  const visibility = await browser.eval("document.visibilityState");
  if (visibility !== "visible") {
    // Every latency and rendering check here depends on frames being produced.
    throw new Error(`page is "${visibility}", not visible; rAF would never fire`);
  }

  const { results, latency, longTasks } = await runChecks(browser, {
    screenshotsDir: outDir,
    save: (path, base64) => writeFileSync(path, Buffer.from(base64, "base64")),
  });

  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(outDir, "report.json"),
    JSON.stringify({ results, latency, longTasks }, null, 2));

  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`switch latency  p50 ${latency.p50}ms  p95 ${latency.p95}ms  max ${latency.max}ms`);
  console.log(`report: ${join("e2e", "out", "report.json")}\n`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`\ne2e run failed: ${error && error.message ? error.message : error}\n`);
} finally {
  if (browser) await browser.close();
  if (vite) vite.kill("SIGTERM");
  process.exit(exitCode);
}
