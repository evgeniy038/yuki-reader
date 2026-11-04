import type { Route } from "playwright-core";

// The fake Yandex Disk for tests/sync-smoke.ts: OAuth, the REST API and its
// upload/download hosts, emulated by request interception over one
// in-memory folder that every "device" (browser profile) shares.

const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";

export const files = new Map<string, Uint8Array>();
const dirs = new Set<string>([""]);
const hrefs = new Map<string, string>();
let hrefSeq = 0;
/** Knobs and counters the smoke reads and turns. */
export const fake = {
  tokenExchanges: 0,
  /** The cloud is unreachable (the app itself stays cached and usable). */
  down: false,
  /** Per-request delay — a cloud reached through a VPN (~0.5–0.9 s each). */
  latencyMs: 0,
};
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
};
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });

export async function yandex(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (fake.down) return route.abort("internetdisconnected");
  if (fake.latencyMs > 0 && request.method() !== "OPTIONS") await new Promise((resolve) => setTimeout(resolve, fake.latencyMs));
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (url.pathname === "/authorize") {
    const back = `${BASE}/?code=code-${hrefSeq++}&state=${url.searchParams.get("state")}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(request.postData() ?? "");
    if (!form.get("code_verifier") || form.has("client_secret")) return json(route, 400, { error: "invalid_request" });
    fake.tokenExchanges += 1;
    return json(route, 200, { access_token: "tok", refresh_token: "ref", expires_in: 31_536_000 });
  }
  if (url.hostname.includes("uploader") || url.hostname.includes("downloader")) {
    const path = hrefs.get(url.pathname);
    if (path === undefined) return json(route, 404, {});
    if (request.method() === "PUT") {
      files.set(path, new Uint8Array(request.postDataBuffer() ?? Buffer.alloc(0)));
      return route.fulfill({ status: 201, headers: cors });
    }
    const file = files.get(path);
    return file ? route.fulfill({ status: 200, headers: cors, body: Buffer.from(file) }) : json(route, 404, {});
  }
  if (request.headers().authorization !== "OAuth tok") return json(route, 401, { error: "UnauthorizedError" });
  const path = (url.searchParams.get("path") ?? "").replace(/^app:\//, "");
  if (url.pathname.endsWith("/upload")) {
    const id = `/upload/${hrefSeq++}`;
    hrefs.set(id, path);
    return json(route, 200, { href: `https://uploader1j.disk.yandex.net${id}`, method: "PUT" });
  }
  if (url.pathname.endsWith("/download")) {
    if (!files.has(path)) return json(route, 404, { error: "DiskNotFoundError" });
    const id = `/download/${hrefSeq++}`;
    hrefs.set(id, path);
    return json(route, 200, { href: `https://downloader.disk.yandex.ru${id}` });
  }
  if (request.method() === "PUT") {
    if (dirs.has(path)) return json(route, 409, {});
    dirs.add(path);
    return json(route, 201, {});
  }
  if (request.method() === "DELETE") return json(route, files.delete(path) ? 204 : 404, {});
  if (!dirs.has(path)) return json(route, 404, { error: "DiskNotFoundError" });
  const child = (p: string) => p !== path && p.startsWith(path === "" ? "" : `${path}/`) && !p.slice(path.length + 1).includes("/");
  const items = [
    ...[...dirs].filter(child).map((d) => ({ name: d.slice(path.length + 1), type: "dir" })),
    ...[...files].filter(([f]) => child(f)).map(([f, b]) => ({ name: f.slice(path.length + 1), type: "file", md5: String(b.length) + f, modified: String(b[b.length - 1]), size: b.length })),
  ];
  return json(route, 200, { _embedded: { items, total: items.length } });
}
