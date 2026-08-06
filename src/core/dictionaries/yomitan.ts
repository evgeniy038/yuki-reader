import { strFromU8, unzipSync } from "fflate";
import type {
  DictionaryEntryRecord,
  DictionaryProgressListener,
} from "../dictionaries";

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

export function randomId(): string {
  return crypto.randomUUID();
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
  onProgress?: DictionaryProgressListener,
): ParsedDictionary & { id: string } {
  // ponytail: unzipSync keeps large dictionaries in memory; move parsing to a
  // worker/streaming ZIP reader if mobile imports hit the memory ceiling.
  onProgress?.({ phase: "unpack", current: 0, total: 0 });
  const files = unzipSync(archive);
  onProgress?.({ phase: "unpack", current: 1, total: 1 });
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
  onProgress?.({ phase: "index", current: 0, total: bankPaths.length });
  for (const [bankIndex, path] of bankPaths.entries()) {
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
    onProgress?.({
      phase: "index",
      current: bankIndex + 1,
      total: bankPaths.length,
    });
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

export function entryKey(dictionaryId: string, termKey: string, index: number): string {
  return `${dictionaryId}\u0000${termKey}\u0000${String(index).padStart(12, "0")}`;
}
