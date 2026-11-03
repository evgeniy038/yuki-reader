import { useEffect, useRef, useState } from "react";
import { loadMangaPageBlob, type MangaRecord } from "@/core/storage";
import { useLatest } from "@/lib/use-latest";
import { spreadProgress } from "./spread-paging";

/** Keep object URLs this many pages around the current one. */
const URL_WINDOW = 8;

export interface ViewPage {
  num: number;
  url: string;
  width: number;
  height: number;
}

/** Cache key of a visible set ("30,31"). */
export const setKey = (nums: readonly number[]): string => nums.join(",");

// The manga reader's page pipeline: blobs from the pages store become object
// URLs in a small LRU-ish window around the visible page and are revoked
// beyond it (and all of them when the view dies). It resolves whole visible
// SETS — the current one first, then its neighbours — into a small cache, so
// the pager already holds the next and previous spread when a finger starts
// to drag: a turn swaps nothing in, it just slides. Rapid navigation needs
// no token: a late load only fills the cache. Page scans never enter React
// state beyond the resolved sets.
export function useMangaPages({
  bookId,
  record,
  sets,
  numPages,
  onProgress,
}: {
  bookId: string;
  record: MangaRecord | null;
  /** Visible sets to resolve, the current one FIRST (then neighbours). */
  sets: readonly (readonly number[])[];
  numPages: number;
  onProgress?: (progress: number, absolute: number, pageCount: number) => void;
}): ReadonlyMap<string, ViewPage[]> {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, ViewPage[]>>(
    () => new Map(),
  );
  const urlCacheRef = useRef(new Map<number, string>());
  const sizeCacheRef = useRef(new Map<number, { width: number; height: number }>());
  const onProgressRef = useLatest(onProgress);

  // Object URLs die with the view.
  useEffect(() => {
    const cache = urlCacheRef.current;
    setLoaded(new Map());
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, [bookId]);

  const keys = sets.map(setKey).join("|");
  const current = sets[0];

  useEffect(() => {
    if (!record || !current || current.length === 0) return;
    let alive = true;
    const lo = Math.max(1, current[0]! - URL_WINDOW);
    const hi = Math.min(numPages, current[current.length - 1]! + URL_WINDOW);

    const getUrl = async (num: number): Promise<string> => {
      const cached = urlCacheRef.current.get(num);
      if (cached) return cached;
      const blob = await loadMangaPageBlob(bookId, num - 1);
      if (!blob) throw new Error(`missing page ${num}`);
      const url = URL.createObjectURL(blob);
      urlCacheRef.current.set(num, url);
      return url;
    };

    const getSize = async (num: number, url: string) => {
      const cached = sizeCacheRef.current.get(num);
      if (cached) return cached;
      const meta = record.pages[num - 1];
      let size =
        meta?.img_width && meta?.img_height
          ? { width: meta.img_width, height: meta.img_height }
          : undefined;
      if (!size) {
        size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () =>
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error(`bad image ${num}`));
          img.src = url;
        });
      }
      sizeCacheRef.current.set(num, size);
      return size;
    };

    // Evict URLs (and the cached sets built on them) far outside the window
    // — only once the current set is in, so the view never loses the page
    // it still shows while a far jump loads.
    const evict = () => {
      for (const [num, url] of urlCacheRef.current) {
        if (num < lo || num > hi) {
          URL.revokeObjectURL(url);
          urlCacheRef.current.delete(num);
        }
      }
      setLoaded((prev) => {
        const kept = new Map(
          [...prev].filter(([, pages]) =>
            pages.every((page) => page.num >= lo && page.num <= hi),
          ),
        );
        return kept.size === prev.size ? prev : kept;
      });
    };

    void (async () => {
      for (const [index, nums] of sets.entries()) {
        if (!alive) return;
        try {
          const pages: ViewPage[] = [];
          for (const num of nums) {
            const url = await getUrl(num);
            const size = await getSize(num, url);
            pages.push({ num, url, ...size });
          }
          if (!alive) return;
          const key = setKey(nums);
          setLoaded((prev) => {
            if (prev.has(key)) return prev;
            const next = new Map(prev);
            next.set(key, pages);
            return next;
          });
        } catch {
          // A failed set stays out of the cache; the view keeps what it has.
        }
        if (index === 0) evict();
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, keys, bookId]);

  // Progress follows the set actually on screen: it fires once the current
  // set has resolved, never for a set still loading.
  const currentPages = current ? loaded.get(setKey(current)) : undefined;
  useEffect(() => {
    if (!currentPages || currentPages.length === 0) return;
    onProgressRef.current?.(
      spreadProgress(currentPages[0]!.num, numPages),
      currentPages[0]!.num,
      currentPages.length,
    );
  }, [currentPages, numPages, onProgressRef]);

  return loaded;
}
