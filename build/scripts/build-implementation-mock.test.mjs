import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildImplementationMock, renderStandaloneHtml } from "./build-implementation-mock.mjs";

test("the standalone mock identifies its real-frontend source", () => {
  const html = renderStandaloneHtml(".app { color: red; }", "window.__previewLoaded = true;");

  assert.match(html, /anchor-preview" content="generated-from-real-frontend"/);
  assert.match(html, /<div id="root">/);
  assert.match(html, /\.app \{ color: red; \}/);
  assert.match(html, /window\.__previewLoaded = true;/);
});

test("inline assets cannot close their containing tags", () => {
  const html = renderStandaloneHtml(
    "x::after { content: '</style>'; }",
    "console.log('<script></script><!--');",
  );

  assert.match(html, /<\\\/style>/);
  assert.match(html, /\\x3Cscript>/);
  assert.match(html, /<\\\/script>/);
  assert.match(html, /\\x3C!--/);
  assert.equal((html.match(/<\/style>/g) ?? []).length, 1);
  assert.equal((html.match(/<script>/g) ?? []).length, 2);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2);
});

test("an HTML parser keeps the complete application bundle in one executable script", () => {
  const html = renderStandaloneHtml("", "window.fixture = '<script></script><!--';");
  const scriptBlocks = html.split("<script>");
  const applicationScript = scriptBlocks[2]?.split("</script>")[0] ?? "";

  assert.equal(scriptBlocks.length, 3);
  assert.match(applicationScript, /window\.fixture/);
  assert.doesNotThrow(() => new Function(applicationScript));
});

test("the full standalone preview has valid scripts without Node environment checks", async () => {
  const html = await buildImplementationMock();
  const dom = new JSDOM(html);
  const scripts = [...dom.window.document.scripts];

  assert.equal(scripts.length, 2);
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script.textContent));
  }
  assert.doesNotMatch(html, /process\.env\.NODE_ENV/);
  dom.window.close();
});
