import { strict as assert } from "node:assert";
import { strToU8, zipSync } from "fflate";
import {
  dictionaryGlossaryHtml,
  normalizeDictionaryTerm,
  parseYomitanDictionary,
} from "../src/core/dictionaries.ts";

const archive = zipSync({
  "index.json": strToU8(
    JSON.stringify({ title: "Test dictionary", revision: "1", format: 3 }),
  ),
  "term_bank_1.json": strToU8(
    JSON.stringify([
      ["ＣＡＴ", "cat", "noun", ["v1"], 10, ["a small animal"], 1, "common"],
      ["猫", "ねこ", "", [], 0, [{ type: "structured-content", content: [{ tag: "b", content: "cat" }] }], 2, ""],
    ]),
  ),
});

const parsed = parseYomitanDictionary(archive, "test");
assert.equal(parsed.title, "Test dictionary");
assert.equal(parsed.entries.length, 2);
assert.equal(parsed.entries[0]?.termKey, "cat");
assert.equal(parsed.entries[1]?.reading, "ねこ");
assert.equal(normalizeDictionaryTerm(" ＣＡＴ "), "cat");
assert.ok(dictionaryGlossaryHtml(parsed.entries[1]?.glossary[0]).includes("<b>cat</b>"));

console.log("Dictionary parser smoke: PASS");
