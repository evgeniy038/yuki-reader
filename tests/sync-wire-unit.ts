import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { mock } from "node:test";
import { loadMangaPageBlob, loadShelfBooks } from "../src/core/storage.ts";
import { planPack, type PackSource } from "../src/core/sync/book-pack.ts";
import { PackError, streamPack } from "../src/core/sync/pack-stream.ts";
import { FRAME, parseMessage, PeerUnreachableError, receiveBook, sendBook, WINDOW } from "../src/components/sync/p2p-wire.ts";
import { MAX_METADATA, STALL_MS } from "../src/components/sync/p2p-protocol.ts";

class Wire extends EventTarget {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer: Wire | null = null;
  binaryBytes = 0;
  maxMessage = 0;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState !== "open") throw new Error("closed");
    const bytes = typeof data === "string" ? new TextEncoder().encode(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    assert.ok(bytes);
    assert.ok(bytes.length <= FRAME, "every message fits the negotiated channel limit");
    this.maxMessage = Math.max(this.maxMessage, bytes.length);
    if (typeof data !== "string") this.binaryBytes += bytes.length;
    const copy = typeof data === "string" ? data : bytes.slice().buffer;
    queueMicrotask(() => {
      if (this.peer?.readyState === "open") this.peer.dispatchEvent(new MessageEvent("message", { data: copy }));
    });
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    this.peer?.close();
  }
  message(data: unknown): void { this.dispatchEvent(new MessageEvent("message", { data })); }
}
const source: PackSource = {
  record: { id: "sender", title: "volume", format: "manga", addedAt: 1, progress: 0, chapters: [] },
  manga: {
    record: { id: "sender", pages: [{ path: "0.jpg" }, { path: "1.jpg" }] },
    page: async (i) => new Blob([new Uint8Array(128 * 1024).fill(i + 1)], { type: "image/jpeg" }),
  },
};
const options = (id: string) => ({ key: "book", id, personal: { progress: 0, addedAt: 1 }, onProgress: () => {} });
const waitFor = async (condition: () => Promise<boolean> | boolean) => {
  const end = Date.now() + 2_000;
  while (!(await condition())) {
    assert.ok(Date.now() < end, "condition completed before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// Large sidecars/covers used to exceed SCTP's message size before any bytes
// of the book could move. Include multibyte text in the framing regression.
{
  const large: PackSource = { ...source, record: { ...source.record, cover: "雪".repeat(150_000) } };
  const [tx, rx] = [new Wire(), new Wire()];
  tx.peer = rx;
  rx.peer = tx;
  let sending = Promise.resolve();
  tx.addEventListener("message", (event) => {
    const message = parseMessage(String((event as MessageEvent).data));
    if (message?.t === "get") sending = sendBook(tx, large, message.window, { framed: message.framed, frame: FRAME });
  });
  const book = await receiveBook(rx, options("large-metadata"));
  await sending;
  assert.equal(book.cover, large.record.cover);
  assert.equal((await loadMangaPageBlob(book.id, 1))?.size, 128 * 1024);
  assert.ok(tx.binaryBytes > 450_000);
  assert.equal(tx.maxMessage, FRAME);
  console.log("  ✓ large UTF-8 metadata is framed and the complete volume arrives");
}

// Close while the sender is waiting for its browser's send buffer to drain.
{
  const tx = new Wire();
  tx.bufferedAmount = 8 * 1024 * 1024;
  const sending = sendBook(tx, source, WINDOW);
  const rejected = assert.rejects(sending, PeerUnreachableError);
  await new Promise((resolve) => setTimeout(resolve, 10));
  tx.close();
  await rejected;
  assert.equal(tx.binaryBytes, 0);
  console.log("  ✓ closing a full send buffer releases the sender");
}

// A missing end marker, including after a page has already been stored,
// must roll back before a new connection can retry with the same id.
{
  const rx = new Wire();
  const receiving = receiveBook(rx, options("interrupted"));
  const rejected = assert.rejects(receiving, PeerUnreachableError);
  const plan = (await planPack(source))!;
  rx.message(JSON.stringify({ t: "manifest", manifest: plan.manifest }));
  await streamPack(plan, FRAME, async (bytes) => rx.message(bytes.slice().buffer));
  await waitFor(async () => !!(await loadMangaPageBlob("interrupted", 1)));
  rx.close();
  await rejected;
  assert.equal(await loadMangaPageBlob("interrupted", 0), undefined);
  assert.equal(await loadMangaPageBlob("interrupted", 1), undefined);
  assert.ok(!(await loadShelfBooks()).some((book) => book.id === "interrupted"));
  console.log("  ✓ a dropped channel removes all partial pages before rejecting");
}

// A queued end marker is allowed to finish even if the channel closes while
// IndexedDB is still catching up; a second manifest is never allowed.
{
  const plan = (await planPack(source))!;
  for (const duplicate of [false, true]) {
    const rx = new Wire();
    const receiving = receiveBook(rx, options(`ordered-${duplicate}`));
    const rejected = duplicate ? assert.rejects(receiving, PackError) : null;
    rx.message(JSON.stringify({ t: "manifest", manifest: plan.manifest }));
    await streamPack(plan, FRAME, async (bytes) => rx.message(bytes.slice().buffer));
    if (duplicate) rx.message(JSON.stringify({ t: "manifest", manifest: plan.manifest }));
    rx.message(JSON.stringify({ t: "end" }));
    rx.close();
    if (rejected) {
      await rejected;
      assert.equal(await loadMangaPageBlob("ordered-true", 0), undefined);
    } else assert.equal((await receiving).id, "ordered-false");
  }
  console.log("  ✓ queued completion survives close; duplicate metadata rolls back");
}

{
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rx = new Wire();
    const receiving = receiveBook(rx, options("silent"));
    const rejected = assert.rejects(receiving, PeerUnreachableError);
    mock.timers.tick(STALL_MS + 1);
    await rejected;
    assert.equal(rx.readyState, "closed");
  } finally { mock.timers.reset(); }
  assert.equal(parseMessage('{"t":"get","key":"k","window":0}'), null);
  assert.equal(parseMessage('{"t":"get","key":"k","window":12}'), null);
  assert.equal(parseMessage('{"t":"ack","stored":-1}'), null);
  assert.equal(parseMessage('{"t":"ack","stored":1e400}'), null);
  assert.equal(parseMessage(JSON.stringify({ t: "metadata", size: MAX_METADATA + 1 })), null);
  console.log("  ✓ silent channels time out; malformed limits and acknowledgements are rejected");
}
console.log("sync-wire-unit: all checks passed");
