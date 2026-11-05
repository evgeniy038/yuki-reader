import type { BookFormat } from "@/core/library";
import { isReady, processingOf, type Processing } from "@/core/sync/ready";

// Is a book ready to be offered to the other devices (core/sync/ready.ts)?
// Asked every round for every book by the catalog, the uploads and the
// direct transfers — so the answer is kept: a ready book stays ready for
// the session (the OCR engine is a build constant), one still processing
// is looked at again after a short while, and sooner when its OCR is done
// or another device's text lands (forgetReadiness).

const RECHECK_MS = 15_000;
const known = new Map<string, { at: number; processing: Processing | null }>();

export async function readinessOf(id: string, format: BookFormat | undefined): Promise<Processing | null> {
  const hit = known.get(id);
  if (hit && (isReady(hit.processing) || Date.now() - hit.at < RECHECK_MS)) return hit.processing;
  const processing = await processingOf(id, format);
  known.set(id, { at: Date.now(), processing });
  return processing;
}

export function forgetReadiness(id: string): void {
  known.delete(id);
}
