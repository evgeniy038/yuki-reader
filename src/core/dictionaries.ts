import { strFromU8, unzipSync } from "fflate";
import {
  deleteDictionary as deleteStoredDictionary,
  loadAllDictionaries,
  loadDictionaryEntries,
  replaceDictionary,
  setDictionaryEnabled,
  setDictionaryOrder,
} from "./storage";

export interface DictionaryRecord {
  id: string;
  title: string;
  revision?: string;
  format?: number;
  author?: string;
  description?: string;
  attribution?: string;
  sourceUrl?: string;
  language?: string;
  enabled: boolean;
  order: number;
  entryCount: number;
  importedAt: number;
}

export interface DictionaryArchiveRecord {
  id: string;
  bytes: Uint8Array;
}

export interface DictionaryEntryRecord {
  key: string;
  dictionaryId: string;
  term: string;
  termKey: string;
  reading?: string;
  definitionTags?: string;
  rules: string[];
  score?: number;
  glossary: unknown[];
  sequence?: number;
  termTags?: string;
}

export interface DictionaryLookup {
  dictionary: DictionaryRecord;
  entry: DictionaryEntryRecord;
}

export interface DictionaryCatalogItem {
  id: string;
  title: string;
  direction: "en-en" | "en-ru" | "ja-en";
  sourceLabel: string;
  sourceUrl: string;
  license: string;
}

// These are generated from Wiktionary data by Yomidevs' maintained WTY
// pipeline. The app links to the latest public package instead of bundling
// 100+ MB of dictionary data into every release.
export const DICTIONARY_CATALOG: DictionaryCatalogItem[] = [
  {
    id: "wty-en-en",
    title: "Wiktionary English",
    direction: "en-en",
    sourceLabel: "WTY · Yomidevs",
    sourceUrl:
      "https://huggingface.co/datasets/daxida/wty-release/resolve/main/latest/dict/en/en/wty-en-en.zip",
    license: "CC BY-SA 4.0",
  },
  {
    id: "wty-en-ru",
    title: "Wiktionary English → Russian",
    direction: "en-ru",
    sourceLabel: "WTY · Yomidevs",
    sourceUrl:
      "https://huggingface.co/datasets/daxida/wty-release/resolve/main/latest/dict/en/ru/wty-en-ru.zip",
    license: "CC BY-SA 4.0",
  },
  {
    id: "wty-ja-en",
    title: "Wiktionary Japanese → English",
    direction: "ja-en",
    sourceLabel: "WTY · Yomidevs",
    sourceUrl:
      "https://huggingface.co/datasets/daxida/wty-release/resolve/main/latest/dict/ja/en/wty-ja-en.zip",
    license: "CC BY-SA 4.0",
  },
];

export const DICTIONARIES_CHANGED_EVENT = "yuki:dictionaries-changed";

function notifyDictionaryChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DICTIONARIES_CHANGED_EVENT));
  }
}

export interface ParsedDictionary {
  title: string;
  revision?: string;
  format?: number;
  author?: string;
  description?: string;
  attribution?: string;
  sourceUrl?: string;
  language?: string;
  entries: Omit<DictionaryEntryRecord, "dictionaryId" | "key">[];
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `dictionary-${Date.now()}-${Math.random()}`;
}

export function normalizeDictionaryTerm(term: string): string {
  return term.normalize("NFKC").trim().toLocaleLowerCase();
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseIndex(bytes: Uint8Array): Record<string, unknown> {
  const raw = JSON.parse(strFromU8(bytes)) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Dictionary index.json is not an object");
  }
  return raw as Record<string, unknown>;
}

function bankNumber(path: string): number {
  const match = path.match(/term_bank_(\d+)\.json$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** Parse the standard Yomitan ZIP shape. EPWING belongs in Yomitan Import. */
export function parseYomitanDictionary(
  archive: Uint8Array,
  dictionaryId = randomId(),
): ParsedDictionary & { id: string } {
  // ponytail: unzipSync keeps large dictionaries in memory; move parsing to a
  // worker/streaming ZIP reader if mobile imports hit the memory ceiling.
  const files = unzipSync(archive);
  const indexFile = files["index.json"];
  if (!indexFile) throw new Error("Dictionary ZIP is missing index.json");
  const index = parseIndex(indexFile);
  const title = stringOr(index.title);
  if (!title) throw new Error("Dictionary index.json is missing title");

  const bankPaths = Object.keys(files)
    .filter((path) => /(?:^|\/)term_bank_\d+\.json$/i.test(path))
    .sort((a, b) => bankNumber(a) - bankNumber(b) || a.localeCompare(b));
  if (bankPaths.length === 0) {
    throw new Error("Dictionary ZIP has no term banks");
  }

  const entries: ParsedDictionary["entries"] = [];
  for (const path of bankPaths) {
    const raw = JSON.parse(strFromU8(files[path]!)) as unknown;
    if (!Array.isArray(raw)) throw new Error(`Invalid term bank: ${path}`);
    for (const row of raw) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const glossary = Array.isArray(row[5]) ? row[5] : [row[5]];
      const rules = Array.isArray(row[3])
        ? row[3].filter((rule): rule is string => typeof rule === "string")
        : [];
      const score = typeof row[4] === "number" ? row[4] : undefined;
      const sequence = typeof row[6] === "number" ? row[6] : undefined;
      entries.push({
        term: row[0],
        termKey: normalizeDictionaryTerm(row[0]),
        ...(stringOr(row[1]) ? { reading: row[1] as string } : {}),
        ...(stringOr(row[2]) ? { definitionTags: row[2] as string } : {}),
        rules,
        ...(score === undefined ? {} : { score }),
        glossary,
        ...(sequence === undefined ? {} : { sequence }),
        ...(stringOr(row[7]) ? { termTags: row[7] as string } : {}),
      });
    }
  }

  return {
    id: dictionaryId,
    title,
    ...(stringOr(index.revision ?? index.version)
      ? { revision: String(index.revision ?? index.version) }
      : {}),
    ...(typeof index.format === "number" ? { format: index.format } : {}),
    ...(stringOr(index.author) ? { author: index.author as string } : {}),
    ...(stringOr(index.description)
      ? { description: index.description as string }
      : {}),
    ...(stringOr(index.attribution)
      ? { attribution: index.attribution as string }
      : {}),
    ...(stringOr(index.url) ? { sourceUrl: index.url as string } : {}),
    ...(stringOr(index.language)
      ? { language: index.language as string }
      : {}),
    entries,
  };
}

function entryKey(dictionaryId: string, termKey: string, index: number): string {
  return `${dictionaryId}\u0000${termKey}\u0000${String(index).padStart(12, "0")}`;
}

export interface DictionaryImportOptions {
  id?: string;
  sourceUrl?: string;
  enabled?: boolean;
  order?: number;
}

async function importDictionaryArchiveInProcess(
  archive: Uint8Array,
  options: DictionaryImportOptions = {},
): Promise<DictionaryRecord> {
  const id = options.id ?? randomId();
  const parsed = parseYomitanDictionary(archive, id);
  const current = await loadAllDictionaries();
  const record: DictionaryRecord = {
    id,
    title: parsed.title,
    ...(parsed.revision ? { revision: parsed.revision } : {}),
    ...(parsed.format === undefined ? {} : { format: parsed.format }),
    ...(parsed.author ? { author: parsed.author } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(parsed.attribution ? { attribution: parsed.attribution } : {}),
    ...(options.sourceUrl || parsed.sourceUrl
      ? { sourceUrl: options.sourceUrl ?? parsed.sourceUrl }
      : {}),
    ...(parsed.language ? { language: parsed.language } : {}),
    enabled: options.enabled ?? true,
    order: options.order ?? current.length,
    entryCount: parsed.entries.length,
    importedAt: Date.now(),
  };
  const entries = parsed.entries.map((entry, index) => ({
    ...entry,
    dictionaryId: id,
    key: entryKey(id, entry.termKey, index),
  }));
  await replaceDictionary(record, archive, entries);
  return record;
}

type DictionaryWorkerMessage = {
  type: "import";
  archive: ArrayBuffer;
  options: DictionaryImportOptions;
};

type DictionaryWorkerResponse =
  | { type: "done"; record: DictionaryRecord }
  | { type: "error"; message: string };

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  return (
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer
  ) as ArrayBuffer;
}

function importDictionaryArchiveInWorker(
  archive: Uint8Array,
  options: DictionaryImportOptions,
): Promise<DictionaryRecord> {
  const worker = new Worker(new URL("./dictionary.worker.ts", import.meta.url), {
    type: "module",
  });
  const buffer = transferableBuffer(archive);
  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<DictionaryWorkerResponse>) => {
      finish();
      if (event.data.type === "error") {
        reject(new Error(event.data.message));
      } else {
        resolve(event.data.record);
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Dictionary worker failed"));
    };
    worker.postMessage({ type: "import", archive: buffer, options }, [buffer]);
  });
}

export async function importDictionaryArchive(
  archive: Uint8Array,
  options: DictionaryImportOptions = {},
): Promise<DictionaryRecord> {
  const record =
    typeof window !== "undefined" && typeof Worker !== "undefined"
      ? await importDictionaryArchiveInWorker(archive, options)
      : await importDictionaryArchiveInProcess(archive, options);
  notifyDictionaryChange();
  return record;
}

export async function installDictionaryFromUrl(
  item: DictionaryCatalogItem,
): Promise<DictionaryRecord> {
  const response = await fetch(item.sourceUrl);
  if (!response.ok) throw new Error(`Dictionary download failed (${response.status})`);
  const archive = new Uint8Array(await response.arrayBuffer());
  return importDictionaryArchive(archive, {
    id: item.id,
    sourceUrl: item.sourceUrl,
  });
}

export async function lookupDictionaries(term: string): Promise<DictionaryLookup[]> {
  const termKey = normalizeDictionaryTerm(term);
  if (!termKey) return [];
  const dictionaries = await loadAllDictionaries();
  const results: DictionaryLookup[] = [];
  for (const dictionary of dictionaries) {
    if (!dictionary.enabled) continue;
    const entries = await loadDictionaryEntries(dictionary.id, termKey);
    for (const entry of entries) results.push({ dictionary, entry });
  }
  return results;
}

export async function updateDictionaryEnabled(id: string, enabled: boolean) {
  await setDictionaryEnabled(id, enabled);
  notifyDictionaryChange();
}

export async function removeDictionary(id: string) {
  await deleteStoredDictionary(id);
  notifyDictionaryChange();
}

export async function reorderDictionaries(ids: string[]) {
  await setDictionaryOrder(ids);
  notifyDictionaryChange();
}

export { loadAllDictionaries };

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] ?? char);
}

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
