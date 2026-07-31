// Character-position model for the paginated reader.
//
// The reading position is stored as a CHARACTER COUNT ("chars read"), never
// in pixels or page indices, so it survives any relayout — window resize,
// zoom, fullscreen, font-size change. After a relayout the count maps back
// to the page that contains the next unread character.
//
// Counting rules (same as the reference reader, so progress numbers agree):
// only Japanese characters and ASCII/full-width alphanumerics count —
// punctuation, whitespace and symbols are stripped; <rt> ruby annotations
// and hidden subtrees are skipped; a gaiji image counts as one character.
//
// The mapping is GLYPH-precise, not node-granular: Japanese prose is long
// text nodes that routinely span page boundaries, so explored(page) returns
// the first glyph actually rendered on the page (bisecting inside the
// boundary-spanning node) and pageForChar(count) locates the page of the
// exact glyph at `count`. Both round-trip exactly at any layout.
//
// The node→page mapping is computed ON DEMAND: document order is
// page-monotonic, so the queries binary-search it, measuring only the
// O(log n) rects they visit instead of laying out the whole book on every
// relayout. Per-layout results are memoized until the next bind().

const NON_COUNTABLE =
  /[^0-9A-Z○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー０-９Ａ-Ｚｦ-ﾝ\p{Radical}\p{Unified_Ideograph}]+/gimu;

function isGaiji(node: Node): boolean {
  return (
    node instanceof HTMLImageElement &&
    Array.from(node.classList).some((c) => c.includes("gaiji"))
  );
}

function isHidden(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (node.hasAttribute("aria-hidden") || node.hasAttribute("hidden"))
  );
}

function charCountOf(node: Node): number {
  if (isGaiji(node)) return 1;
  const text = node.textContent;
  if (!text) return 0;
  // Array.from: count code points, not UTF-16 units (𠮟る is 2 chars).
  return Array.from(text.replace(NON_COUNTABLE, "")).length;
}

// Countable characters in an HTML fragment without rendering it — for the
// book-details dialog. Ruby annotations and hidden subtrees are dropped
// before counting, matching the reader's numbers.
export function charCountOfHtml(html: string): number {
  const el = document.createElement("div");
  el.innerHTML = html;
  el.querySelectorAll("rt, [hidden], [aria-hidden]").forEach((n) => n.remove());
  return countableNodes(el).reduce((sum, node) => sum + charCountOf(node), 0);
}

// Countable leaves of the flow: text nodes with visible text + gaiji images.
function countableNodes(root: Node): Node[] {
  const out: Node[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent?.replace(/\s/g, "")) out.push(child);
      } else if (isGaiji(child)) {
        out.push(child);
      } else if (child.nodeName !== "RT" && !isHidden(child)) {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/** One section's countable characters + its search-index entries. */
interface SectionMeasure {
  /** Countable characters in the section. */
  chars: number;
  /** Every countable node's raw text + its GLOBAL char offset (baseOffset =
      the section's book-wide start) — the search index, layout-independent. */
  index: { text: string; offset: number }[];
}

// Measure a section's parsed body in one walk — used at article-build time,
// so char offsets for the whole book are known without laying anything out.
export function measureSection(root: Element, baseOffset: number): SectionMeasure {
  let sum = 0;
  const index = countableNodes(root).map((node) => {
    const entry = { text: node.textContent ?? "", offset: baseOffset + sum };
    sum += charCountOf(node);
    return entry;
  });
  return { chars: sum, index };
}

export class ReadingStats {
  /** Total countable characters in the book. */
  readonly total: number;

  private readonly nodes: Node[];
  /** acc[i] = countable chars in nodes[0..i] (cumulative, non-decreasing). */
  private readonly acc: number[] = [];

  // Layout context captured by bind(). Flow coordinates (rect edge − base +
  // CURRENT scroll) are scroll-invariant, so one bind per (re)layout serves
  // all queries until the next measure — including queries fired after the
  // reader scrolled to a page.
  private scrollEl: HTMLElement | null = null;
  private base = 0;
  private step = 0;
  private vertical = true;
  private range: Range | null = null;
  /** Memoized pageOfNode/leadingPageOfNode results; invalidated by bind. */
  private readonly pageCache = new Map<number, number>();
  private readonly leadingCache = new Map<number, number>();
  /** Memoized explored(page) and pageForChar(count); invalidated by bind. */
  private readonly exploredCache = new Map<number, number>();
  private readonly charPageCache = new Map<number, number>();
  /** Per text node: UTF-16 offset of each countable char (+ sentinel end).
      Node text is constant, so these survive relayouts. */
  private readonly countableTables = new WeakMap<Node, Uint32Array>();

  constructor(root: Element) {
    this.nodes = countableNodes(root);
    let sum = 0;
    for (const node of this.nodes) {
      sum += charCountOf(node);
      this.acc.push(sum);
    }
    this.total = sum;
  }

  /**
   * Capture the layout context after a (re)layout. `step` is the page pitch
   * (viewport + gap); the paging axis is scrollTop in vertical writing,
   * scrollLeft in horizontal. Cheap — one rect read; the node→page mapping
   * itself is left to the queries below.
   */
  bind(scrollEl: HTMLElement, step: number, vertical: boolean): void {
    const box = scrollEl.getBoundingClientRect();
    this.scrollEl = scrollEl;
    this.base = vertical ? box.top : box.left;
    this.step = step;
    this.vertical = vertical;
    this.range ??= scrollEl.ownerDocument.createRange();
    this.pageCache.clear();
    this.leadingCache.clear();
    this.exploredCache.clear();
    this.charPageCache.clear();
  }

  /** Flow coordinate of `rect`'s leading/trailing edge, scroll read fresh. */
  private flowEdge(rect: DOMRect, trailing: boolean): number {
    const scrolled = this.vertical
      ? this.scrollEl!.scrollTop
      : this.scrollEl!.scrollLeft;
    const edge = this.vertical
      ? trailing
        ? rect.bottom
        : rect.top
      : trailing
        ? rect.right
        : rect.left;
    return edge - this.base + scrolled;
  }

  /** Rect of a node, text via range, elements directly. */
  private nodeRect(index: number): DOMRect {
    const node = this.nodes[index]!;
    if (node.nodeType === Node.TEXT_NODE) {
      this.range!.selectNodeContents(node);
      return this.range!.getBoundingClientRect();
    }
    return (node as Element).getBoundingClientRect();
  }

  /** Page of a flow edge: column k spans (k·step, k·step + viewport]. */
  private pageOfEdge(edge: number, trailing: boolean): number {
    return Math.max(
      0,
      trailing ? Math.ceil(edge / this.step) - 1 : Math.floor(edge / this.step),
    );
  }

  /**
   * Page of nodes[index] under the bound layout, derived from its TRAILING
   * edge along the paging axis. Zero-size (not-yet-rendered or CSS-hidden)
   * nodes inherit the previous node's page, keeping pages non-decreasing in
   * document order.
   */
  private pageOfNode(index: number): number {
    const cached = this.pageCache.get(index);
    if (cached !== undefined) return cached;
    for (let i = index; i >= 0; i -= 1) {
      const rect = this.nodeRect(i);
      if ((this.vertical ? rect.height : rect.width) <= 0) continue;
      const page = this.pageOfEdge(this.flowEdge(rect, true), true);
      this.pageCache.set(index, page);
      return page;
    }
    return 0;
  }

  /** Same as pageOfNode but for the LEADING edge (where the node starts). */
  private leadingPageOfNode(index: number): number {
    const cached = this.leadingCache.get(index);
    if (cached !== undefined) return cached;
    for (let i = index; i >= 0; i -= 1) {
      const rect = this.nodeRect(i);
      if ((this.vertical ? rect.height : rect.width) <= 0) continue;
      const page = this.pageOfEdge(this.flowEdge(rect, false), false);
      this.leadingCache.set(index, page);
      return page;
    }
    return 0;
  }

  /** UTF-16 offsets of a text node's countable chars (+ text length). */
  private countableTable(node: Node): Uint32Array {
    let table = this.countableTables.get(node);
    if (table) return table;
    const text = node.textContent ?? "";
    const offsets: number[] = [];
    let u16 = 0;
    for (const cp of text) {
      if (cp.replace(NON_COUNTABLE, "") !== "") offsets.push(u16);
      u16 += cp.length;
    }
    offsets.push(u16);
    table = new Uint32Array(offsets);
    this.countableTables.set(node, table);
    return table;
  }

  /**
   * Page of the glyph that is the k-th countable char of text node
   * `index`. Zero-size glyphs (CSS-hidden text) fall back to the node page.
   */
  private glyphPage(index: number, k: number): number {
    const node = this.nodes[index]!;
    const text = node.textContent ?? "";
    const table = this.countableTable(node);
    const start = table[Math.min(k, table.length - 2)]!;
    const lead = text.charCodeAt(start);
    const units = lead >= 0xd800 && lead <= 0xdbff ? 2 : 1;
    this.range!.setStart(node, start);
    this.range!.setEnd(node, start + units);
    const rect = this.range!.getBoundingClientRect();
    if ((this.vertical ? rect.height : rect.width) <= 0)
      return this.pageOfNode(index);
    return this.pageOfEdge(this.flowEdge(rect, true), true);
  }

  /** Characters read before the first glyph rendered on `page`. */
  explored(page: number): number {
    if (this.nodes.length === 0 || this.range === null || page <= 0) return 0;
    const memo = this.exploredCache.get(page);
    if (memo !== undefined) return memo;
    // First node whose trailing edge reaches `page`.
    let lo = 0;
    let hi = this.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pageOfNode(mid) >= page) hi = mid;
      else lo = mid + 1;
    }
    let result: number;
    if (lo === 0) {
      result = 0;
    } else if (lo >= this.nodes.length) {
      result = this.total;
    } else {
      const before = this.acc[lo - 1] ?? 0;
      const node = this.nodes[lo]!;
      if (node.nodeType !== Node.TEXT_NODE) {
        // Atomic node (gaiji image): even a straddling image counts as ON
        // `page`, not before it — so everything before it, and no more.
        result = before;
      } else if (this.leadingPageOfNode(lo) >= page) {
        // The node starts on or after `page` — everything before it is read.
        result = before;
      } else {
        // The node spans the page boundary: bisect inside it for the first
        // countable char whose glyph lands on or after `page`.
        const table = this.countableTable(node);
        const len = table.length - 1;
        let kLo = 0;
        let kHi = len;
        while (kLo < kHi) {
          const kMid = (kLo + kHi) >> 1;
          if (this.glyphPage(lo, kMid) >= page) kHi = kMid;
          else kLo = kMid + 1;
        }
        result = before + kLo;
      }
    }
    this.exploredCache.set(page, result);
    return result;
  }

  /** Page containing the next unread glyph after `count` read characters. */
  pageForChar(count: number): number {
    if (this.range === null || count <= 0) return 0;
    const memo = this.charPageCache.get(count);
    if (memo !== undefined) return memo;
    // First node with acc[i] > count — it holds character index `count`.
    let lo = 0;
    let hi = this.acc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.acc[mid] ?? 0) > count) hi = mid;
      else lo = mid + 1;
    }
    const index = Math.min(lo, this.nodes.length - 1);
    const node = this.nodes[index]!;
    let page: number;
    if (node.nodeType === Node.TEXT_NODE) {
      page = this.glyphPage(index, count - (this.acc[index - 1] ?? 0));
    } else {
      page = this.pageOfNode(index);
    }
    this.charPageCache.set(count, page);
    return page;
  }
}
