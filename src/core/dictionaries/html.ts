import { escapeHtml } from "../escape-html";

function structuredContent(value: unknown): string {
  if (typeof value === "string") return escapeHtml(value);
  if (Array.isArray(value)) return value.map(structuredContent).join("");
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  if (typeof object.text === "string") return escapeHtml(object.text);
  if (object.content !== undefined) {
    const content = structuredContent(object.content);
    const tag = typeof object.tag === "string" && /^[a-z][a-z0-9-]*$/i.test(object.tag)
      ? object.tag
      : "div";
    return `<${tag}>${content}</${tag}>`;
  }
  return "";
}

/** Convert Yomitan glossary values to displayable HTML; the UI sanitizes it. */
export function dictionaryGlossaryHtml(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(dictionaryGlossaryHtml).join("");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.type === "structured-content") return structuredContent(object.content);
    if (typeof object.text === "string") return escapeHtml(object.text);
    if (object.content !== undefined) return structuredContent(object.content);
  }
  return escapeHtml(String(value ?? ""));
}

/** Keep useful dictionary markup while removing executable content/URLs. */
export function sanitizeDictionaryHtml(html: string): string {
  if (typeof DOMParser === "undefined") return escapeHtml(html);
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  document.querySelectorAll("script, iframe, object, embed, form, link, meta, style, svg").forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || name === "style") node.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && !/^(https?:|data:image\/)/.test(value)) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return document.body.innerHTML;
}
