import { strict as assert } from "node:assert";
import { scopeBookCss } from "../src/core/book-css.ts";

function main(): void {
  const input = [
    "body { margin: 0; }",
    "html { font-size: 10px; }",
    ".indent { color: red; line-height: 1.5; text-indent: 1em; }",
    "@media screen { .x { writing-mode: vertical-rl; color: blue; } }",
    "@font-face { font-family: YukiFont; src: url(y.woff); }",
    "@import url(flow0001.css);",
    '.pfx { -epub-text-align-last: right; -webkit-text-emphasis-style: "filled sesame"; }',
    ".sans { font-family: Arial, sans-serif; }",
    ".serif { font-family: serif; }",
    ".wb { word-break: break-all; }",
    ".wb2 { word-break: break-all; line-break: strict; }",
    ".vm { -epub-writing-mode: vertical-rl; }",
  ].join(" ");

  const out = scopeBookCss(input, ".book-content");

  // scoped + kept
  assert.ok(out.includes(".book-content .indent"), "selector prefixed");
  assert.ok(out.includes("color: red") || out.includes("color:red"), "kept decl");
  // stripped declarations
  assert.ok(!/line-height/i.test(out), "line-height stripped");
  assert.ok(!/text-indent/i.test(out), "text-indent stripped");
  assert.ok(!/writing-mode/i.test(out), "writing-mode stripped (also converted -epub-)");
  // html/body rules dropped
  assert.ok(!/\bbody\s*\{/.test(out), "body rule dropped");
  assert.ok(!/\bhtml\s*\{/.test(out), "html rule dropped");
  // @media preserved with scoped inner selector
  assert.ok(out.includes("@media"), "@media preserved");
  assert.ok(out.includes(".book-content .x"), "media inner selector scoped");
  // @font-face preserved untouched (its font-family must NOT be remapped)
  assert.ok(out.includes("@font-face"), "@font-face preserved");
  assert.ok(out.includes("YukiFont"), "font-family kept");
  // @import dropped (dead when injected mid-document)
  assert.ok(!/@import/i.test(out), "@import dropped");
  // vendor prefixes converted to standard properties
  assert.ok(/text-align-last:\s*right/.test(out), "-epub- unprefixed");
  assert.ok(/text-emphasis-style:\s*"?filled sesame"?/.test(out), "-webkit- unprefixed");
  // font-family remapped to reader variables (only in style rules)
  assert.ok(out.includes("font-family: var(--book-font-sans)"), "sans-serif remapped");
  assert.ok(out.includes("font-family: var(--book-font-serif)"), "serif remapped");
  // word-break: break-all gets line-break: loose unless the rule defines one
  const wb = out.match(/\.book-content \.wb \{([^}]*)\}/)?.[1] ?? "";
  assert.ok(/line-break:\s*loose/.test(wb), "line-break: loose added for break-all");
  const wb2 = out.match(/\.book-content \.wb2 \{([^}]*)\}/)?.[1] ?? "";
  assert.ok(!/loose/.test(wb2), "no loose when line-break already set");
  assert.ok(/line-break:\s*strict/.test(wb2), "existing line-break kept");

  // empty returns ""; malformed input is parsed leniently by postcss (the
  // function must never throw, and never leak unscoped CSS on a hard error).
  assert.equal(scopeBookCss(""), "");
  assert.equal(typeof scopeBookCss("this is not css {{{"), "string");

  console.log("book-css scope smoke: PASS");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
