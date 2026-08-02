import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  dictionaryGlossaryHtml,
  lookupDictionaries,
  sanitizeDictionaryHtml,
  type DictionaryLookup,
} from "@/core/dictionaries";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LookupState {
  term: string;
  results: DictionaryLookup[];
  pending: boolean;
  x: number;
  y: number;
}

function pointText(root: HTMLElement, x: number, y: number): string | null {
  const selection = window.getSelection()?.toString().trim();
  if (selection && selection.length <= 80) return selection;

  const range = document.caretRangeFromPoint?.(x, y);
  const position = document.caretPositionFromPoint?.(x, y);
  const node = range?.startContainer ?? position?.offsetNode ?? null;
  const offset = range?.startOffset ?? position?.offset ?? 0;
  if (node?.nodeType === Node.TEXT_NODE && root.contains(node)) {
    const text = node.textContent ?? "";
    return termAround(text, offset);
  }

  const element = document.elementFromPoint(x, y);
  const block = element?.closest("[data-ocr-block]");
  return block ? block.textContent?.replace(/…/g, "").trim() || null : null;
}

function termAround(text: string, offset: number): string | null {
  const value = text.replace(/\s+/g, " ");
  const safeOffset = Math.min(value.length, Math.max(0, offset));
  const cjk = /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
  if (cjk) {
    let start = safeOffset;
    let end = safeOffset;
    while (start > 0 && !/\s/.test(value[start - 1]!)) start -= 1;
    while (end < value.length && !/\s/.test(value[end]!)) end += 1;
    const cluster = value.slice(start, end).replace(/^[\s。、，！？「」『』]+|[\s。、，！？「」『』]+$/g, "");
    if (!cluster) return null;
    const relative = Math.min(cluster.length, Math.max(0, safeOffset - start));
    const left = Math.max(0, relative - 5);
    return cluster.slice(left, Math.min(cluster.length, left + 12));
  }

  const before = value.slice(0, safeOffset).match(/[\p{L}\p{N}_'’-]+$/u)?.[0] ?? "";
  const after = value.slice(safeOffset).match(/^[\p{L}\p{N}_'’-]+/u)?.[0] ?? "";
  return (before + after).trim() || null;
}

async function lookupLongest(term: string): Promise<{ term: string; results: DictionaryLookup[] }> {
  const candidates = /[\u3040-\u30ff\u3400-\u9fff]/.test(term)
    ? Array.from({ length: Math.min(12, term.length) }, (_, index) =>
        term.slice(0, term.length - index),
      )
    : [term];
  for (const candidate of candidates) {
    const results = await lookupDictionaries(candidate);
    if (results.length > 0) return { term: candidate, results };
  }
  return { term, results: [] };
}

export function DictionaryLookupLayer({
  rootRef,
  enabled,
}: {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
}) {
  const [lookup, setLookup] = useState<LookupState | null>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
  const lastRequest = useRef("");

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    let alive = true;

    const close = () => {
      lastRequest.current = "";
      setLookup(null);
    };
    const run = (event: MouseEvent | KeyboardEvent) => {
      const x = "clientX" in event ? event.clientX : lastPoint.current.x;
      const y = "clientY" in event ? event.clientY : lastPoint.current.y;
      const target = document.elementFromPoint(x, y);
      if (
        !target ||
        !root.contains(target) ||
        target.closest("[data-dictionary-popup], [data-reader-panel], button, input, textarea")
      ) {
        return;
      }
      if (!target.closest(".book-content, [data-ocr-block]")) return;
      const term = pointText(root, x, y)?.trim();
      if (!term || term.length > 80) {
        close();
        return;
      }
      if (lastRequest.current === term) return;
      lastRequest.current = term;
      const maxX = Math.max(12, window.innerWidth - 372);
      const maxY = Math.max(12, window.innerHeight - 330);
      setLookup({ term, results: [], pending: true, x: Math.min(x + 16, maxX), y: Math.min(y + 16, maxY) });
      void lookupLongest(term).then(({ term: matchedTerm, results }) => {
        if (!alive || lastRequest.current !== term) return;
        setLookup((current) =>
          current ? { ...current, term: matchedTerm, results, pending: false } : current,
        );
      });
    };
    const onMove = (event: MouseEvent) => {
      lastPoint.current = { x: event.clientX, y: event.clientY };
      if (!event.shiftKey) {
        close();
        return;
      }
      run(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") run(event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") close();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !lastRequest.current) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      alive = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [enabled, rootRef]);

  return lookup ? (
    <DictionaryPopup
      lookup={lookup}
      onClose={() => {
        lastRequest.current = "";
        setLookup(null);
      }}
    />
  ) : null;
}

function DictionaryPopup({
  lookup,
  onClose,
}: {
  lookup: LookupState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside
      data-dictionary-popup
      role="dialog"
      aria-label={t("reader.dictionary")}
      className="fixed z-[60] flex max-h-[min(26rem,calc(100vh-1.5rem))] w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-subtle bg-raised shadow-floating"
      style={{ left: lookup.x, top: lookup.y }}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-subtle px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-base font-medium text-strong">
          {lookup.term}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          shape="round"
          aria-label={t("reader.close")}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="overflow-y-auto px-3 py-2">
        {lookup.pending ? (
          <p className="py-3 text-sm text-muted-content">{t("reader.dictionarySearching")}</p>
        ) : lookup.results.length === 0 ? (
          <p className="py-3 text-sm text-muted-content">{t("reader.dictionaryEmpty")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {lookup.results.map((result, index) => (
              <section key={`${result.dictionary.id}-${result.entry.key}-${index}`}>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-primary">{result.dictionary.title}</span>
                  {result.entry.reading ? (
                    <span className="text-xs text-muted-content">{result.entry.reading}</span>
                  ) : null}
                </div>
                {result.entry.glossary.map((glossary, glossaryIndex) => (
                  <div
                    key={glossaryIndex}
                    className={cn(
                      "dictionary-gloss mt-1 text-sm leading-relaxed text-default",
                      glossaryIndex > 0 && "border-t border-subtle pt-1",
                    )}
                    dangerouslySetInnerHTML={{
                      __html: sanitizeDictionaryHtml(dictionaryGlossaryHtml(glossary)),
                    }}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
