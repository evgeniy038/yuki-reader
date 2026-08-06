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

// The manga reader's page pipeline: blobs from the pages store become object
// URLs in a small LRU-ish window around the visible page and are revoked
// beyond it (and all of them when the view dies). Rapid navigation is
// token-guarded — the previous page stays on screen until the new one is
// ready. Page scans never enter React state beyond the fitted view set.
export function useMangaPages({
  bookId,
  record,
  first,
  nums,
  numPages,
  onProgress,
}: {
  bookId: string;
  record: MangaRecord | null;
  /** Spread-normalized anchor page — re-runs the load like a page change. */
  first: number;
  /** The visible page set (1 or 2 pages). */
  nums: number[];
  numPages: number;
  onProgress?: (progress: number, absolute: number, pageCount: number) => void;
}) {
  const [view, setView] = useState<{ key: string; pages: ViewPage[] } | null>(null);
  const renderTokenRef = useRef(0);
  const urlCacheRef = useRef(new Map<number, string>());
  const sizeCacheRef = useRef(new Map<number, { width: number; height: number }>());
  const onProgressRef = useLatest(onProgress);

  // Object URLs die with the view.
  useEffect(() => {
    const cache = urlCacheRef.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, [bookId]);

  // Load the visible set (blobs → object URLs, natural sizes from the sidecar
  // or the image itself). Rapid navigation is token-guarded; the previous
  // page stays on screen until the new one is ready.
  useEffect(() => {
    if (!record || nums.length === 0) return;
    const token = (renderTokenRef.current += 1);
    const wanted = new Set<number>();
    for (let n = Math.max(1, nums[0]! - URL_WINDOW); n <= Math.min(numPages, nums[nums.length - 1]! + URL_WINDOW); n++) {
      wanted.add(n);
    }

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

    void (async () => {
      try {
        const pages: ViewPage[] = [];
        for (const num of nums) {
          const url = await getUrl(num);
          const size = await getSize(num, url);
          pages.push({ num, url, ...size });
        }
        if (token !== renderTokenRef.current) return;
        // Evict URLs far outside the window.
        for (const [num, url] of urlCacheRef.current) {
          if (!wanted.has(num)) {
            URL.revokeObjectURL(url);
            urlCacheRef.current.delete(num);
          }
        }
        setView({ key: nums.join(","), pages });
        onProgressRef.current?.(
          spreadProgress(nums[0]!, numPages),
          nums[0]!,
          nums.length,
        );
      } catch {
        // a failed page load leaves the previous page on screen
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, first, nums.length, bookId]);

  return view;
}
