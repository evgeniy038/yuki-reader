import postcss from "postcss";

// Scope an EPUB's stylesheet so it can be injected into document.head without
// leaking into the app UI (postcss is pure JS; the `css` package pulls node
// fs/path via source-map-support and would break the browser/.app bundle):
//   - drop rules whose selectors target html/body
//   - drop @import (it can never resolve: injected mid-document, relative URLs)
//   - convert declarations, APPENDING the converted form after the original so
//     it wins on equal specificity:
//       -epub-x / -webkit-x        -> x
//       font-family with sans-serif -> var(--book-font-sans); serif -> var(--book-font-serif)
//       word-break: break-all without line-break -> add line-break: loose
//     (a CJK line may then break before a kinsoku char instead of overflowing)
//   - strip line-height / text-indent / writing-mode AFTER conversion so the
//     converted copies die too (the reader owns those properties)
//   - prefix every remaining selector with the parent selector
// walkRules recurses into @media, so nested rules are scoped too; @font-face
// and @keyframes pass through untouched. Returns "" on parse failure (never
// leak unscoped CSS).

const HTML = /\bhtml\b/i;
const BODY = /\bbody\b/i;
const STRIP_DECL = /(?:line-height|text-indent|writing-mode)\s*$/i;
const PREFIXED = /^-(?:epub|webkit)-(.+)$/i;
const WORD_BREAK = /^(?:-(?:epub|webkit)-)?word-break$/i;

export function scopeBookCss(cssText: string, parent = ".book-content"): string {
  if (cssText.trim() === "") return "";
  try {
    const root = postcss.parse(cssText);
    root.walkAtRules("import", (atRule) => {
      atRule.remove();
    });
    root.walkRules((rule) => {
      const selectors = rule.selectors.filter(
        (selector) => !HTML.test(selector) && !BODY.test(selector),
      );
      if (selectors.length === 0) {
        rule.remove();
        return;
      }
      rule.selectors = selectors.map((selector) => `${parent} ${selector.trim()}`);

      const hasLineBreak = rule.some(
        (node) => node.type === "decl" && node.prop.toLowerCase() === "line-break",
      );
      const appended: Array<{ prop: string; value: string }> = [];
      rule.walkDecls((decl) => {
        const unprefixed = PREFIXED.exec(decl.prop)?.[1];
        if (unprefixed) appended.push({ prop: unprefixed, value: decl.value });
        if (decl.prop.toLowerCase() === "font-family") {
          if (decl.value.includes("sans-serif"))
            appended.push({ prop: "font-family", value: "var(--book-font-sans)" });
          else if (decl.value.includes("serif"))
            appended.push({ prop: "font-family", value: "var(--book-font-serif)" });
        }
        if (WORD_BREAK.test(decl.prop) && decl.value === "break-all" && !hasLineBreak) {
          appended.push({ prop: "line-break", value: "loose" });
        }
      });
      for (const { prop, value } of appended) rule.append({ prop, value });

      rule.walkDecls((decl) => {
        if (STRIP_DECL.test(decl.prop)) decl.remove();
      });
    });
    return root.toString();
  } catch {
    return "";
  }
}
