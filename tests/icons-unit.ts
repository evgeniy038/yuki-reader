// Node unit test for yuki's icon set (src/components/ui/icons.tsx): every
// glyph sits on the 16-unit grid in one color, and the knockout masks stay
// unique when many icons share a page — a shared mask id would punch one
// icon's details into every other icon. Run: pnpm tsx tests/icons-unit.ts

import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "../src/components/ui/icons.tsx";

const names = Object.keys(icons) as (keyof typeof icons)[];
assert.ok(names.length >= 29, `expected the full set, got ${names.length}`);

// --- each glyph: 16 grid, one color, cut masks wired to their own svg -------
{
  let cuts = 0;
  for (const name of names) {
    const html = renderToStaticMarkup(createElement(icons[name]));
    assert.match(html, /^<svg[^>]* viewBox="0 0 16 16"/, `${name}: 16-unit grid`);
    assert.match(html, /aria-hidden="true"/, `${name}: decorative`);
    assert.ok(html.includes("<path"), `${name}: draws something`);
    const colors = new Set(
      [...html.matchAll(/(?:fill|stroke)="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((c) => c !== "none" && c !== "white" && c !== "black"),
    );
    assert.deepEqual([...colors], ["currentColor"], `${name}: currentColor only`);
    const ref = /mask="url\(#([^)]+)\)"/.exec(html);
    if (ref) {
      cuts++;
      assert.ok(html.includes(`<mask id="${ref[1]}"`), `${name}: mask lives in the same svg`);
    }
  }
  assert.ok(cuts >= 8, `knockout glyphs render their mask (${cuts})`);
  console.log(`  ✓ ${names.length} glyphs: 16 grid, currentColor, masks wired`);
}

// --- many icons in one tree: mask ids never collide -------------------------
{
  const tree = createElement(
    "div",
    null,
    names.flatMap((name) => [
      createElement(icons[name], { key: `${name}-a` }),
      createElement(icons[name], { key: `${name}-b` }),
    ]),
  );
  const html = renderToStaticMarkup(tree);
  const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, "the tree has masks");
  assert.equal(new Set(ids).size, ids.length, "every mask id is unique");
  console.log(`  ✓ ${ids.length} masks in one tree, all ids unique`);
}

// --- props pass through: size and class come from the call site -------------
{
  const html = renderToStaticMarkup(createElement(icons.Plus, { className: "size-4" }));
  assert.match(html, /class="size-4"/);
  assert.match(html, /width="1em"/, "defaults to the text size");
  console.log("  ✓ className passes through, size defaults to 1em");
}

console.log("icons-unit: all checks passed");
