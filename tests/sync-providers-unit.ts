import { strict as assert } from "node:assert";
import { dropboxAuth } from "../src/core/sync/dropbox.ts";
import { pkcePair, postTokenForm, TokenKeeper, type FetchLike, type ProviderAuth } from "../src/core/sync/oauth.ts";
import { AuthRequiredError, QuotaError } from "../src/core/sync/remote.ts";
import type { ProviderSession } from "../src/core/sync/store.ts";
import { yandexAuth } from "../src/core/sync/yandex.ts";

// The two cloud adapters against fakes of their HTTP APIs (request shapes
// as documented): files round-trip, the token is refreshed on a 401 and the
// call retried, a dead grant asks for sign-in, a full disk is reported, and
// no request ever carries a client secret.

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface FakeCloud {
  files: Map<string, Uint8Array>;
  fetch: FetchLike;
  calls: { url: string; init?: RequestInit }[];
  full: boolean;
}

const header = (init: RequestInit | undefined, name: string): string | undefined => {
  const headers = new Headers(init?.headers);
  return headers.get(name) ?? undefined;
};

function tokenEndpoint(url: string, init: RequestInit | undefined): Response | undefined {
  if (!url.endsWith("/token")) return undefined;
  const form = new URLSearchParams(String(init?.body ?? ""));
  assert.equal(form.has("client_secret"), false, "a public client never sends a secret");
  if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "dead") {
    return json(400, { error: "invalid_grant" });
  }
  if (form.get("grant_type") === "authorization_code") {
    assert.ok(form.get("code_verifier"), "the code exchange carries the PKCE verifier");
  }
  return json(200, { access_token: "fresh", refresh_token: "r2", expires_in: 14_400 });
}

function yandexFake(): FakeCloud {
  const cloud: FakeCloud = { files: new Map(), calls: [], full: false, fetch: async () => new Response() };
  const dirs = new Set<string>([""]);
  const pending = new Map<string, string>();
  cloud.fetch = async (url, init) => {
    cloud.calls.push({ url, init });
    const token = tokenEndpoint(url, init);
    if (token) return token;
    const u = new URL(url);
    if (u.hostname.endsWith("disk.yandex.net") || u.hostname.endsWith("disk.yandex.ru")) {
      assert.equal(header(init, "Authorization"), undefined, "storage hrefs get no Authorization header");
      const path = pending.get(u.pathname) ?? "";
      if (init?.method === "PUT") {
        if (cloud.full) return new Response(null, { status: 507 });
        cloud.files.set(path, new Uint8Array(await new Response(init.body).arrayBuffer()));
        return new Response(null, { status: 201 });
      }
      const file = cloud.files.get(path);
      return file ? new Response(file as BodyInit) : new Response(null, { status: 404 });
    }
    if (header(init, "Authorization") !== "OAuth fresh") return json(401, { error: "UnauthorizedError" });
    const path = (u.searchParams.get("path") ?? "").replace(/^app:\//, "");
    const method = init?.method ?? "GET";
    if (u.pathname.endsWith("/resources/upload")) {
      const id = `/upload/${pending.size}`;
      pending.set(id, path);
      return json(200, { href: `https://uploader1j.disk.yandex.net${id}`, method: "PUT" });
    }
    if (u.pathname.endsWith("/resources/download")) {
      if (!cloud.files.has(path)) return json(404, { error: "DiskNotFoundError" });
      const id = `/download/${pending.size}`;
      pending.set(id, path);
      return json(200, { href: `https://downloader.disk.yandex.ru${id}` });
    }
    if (method === "PUT") {
      if (dirs.has(path)) return json(409, { error: "DiskPathPointsToExistentDirectoryError" });
      dirs.add(path);
      return json(201, {});
    }
    if (method === "DELETE") return cloud.files.delete(path) ? new Response(null, { status: 204 }) : json(404, {});
    if (!dirs.has(path)) return json(404, { error: "DiskNotFoundError" });
    const items: unknown[] = [];
    for (const dir of dirs) {
      if (dir !== path && dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes("/")) {
        items.push({ name: dir.slice(path.length + 1), type: "dir" });
      }
    }
    for (const [file, data] of cloud.files) {
      if (file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")) {
        items.push({ name: file.slice(path.length + 1), type: "file", md5: String(data.length), modified: "t", size: data.length });
      }
    }
    return json(200, { _embedded: { items, total: items.length } });
  };
  return cloud;
}

function dropboxFake(): FakeCloud {
  const cloud: FakeCloud = { files: new Map(), calls: [], full: false, fetch: async () => new Response() };
  let rev = 0;
  const revs = new Map<string, string>();
  cloud.fetch = async (url, init) => {
    cloud.calls.push({ url, init });
    const token = tokenEndpoint(url, init);
    if (token) return token;
    if (header(init, "Authorization") !== "Bearer fresh") return json(401, { error_summary: "expired_access_token/" });
    const arg = header(init, "Dropbox-API-Arg");
    const body = arg ? (JSON.parse(arg) as { path: string; mode?: string }) : (JSON.parse(String(init?.body)) as { path?: string });
    const path = (body.path ?? "").replace(/^\//, "");
    const notFound = () => json(409, { error_summary: "path/not_found/" });
    if (url.endsWith("/files/upload")) {
      assert.equal((body as { mode?: string }).mode, "overwrite");
      if (cloud.full) return json(409, { error_summary: "path/insufficient_space/" });
      cloud.files.set(path, new Uint8Array(await new Response(init?.body).arrayBuffer()));
      rev += 1;
      revs.set(path, `rev${rev}`);
      return json(200, { name: path });
    }
    if (url.endsWith("/files/download")) {
      const file = cloud.files.get(path);
      return file ? new Response(file as BodyInit) : notFound();
    }
    if (url.endsWith("/files/delete_v2")) return cloud.files.delete(path) ? json(200, {}) : notFound();
    if (url.endsWith("/files/list_folder")) {
      const entries = [...cloud.files]
        .filter(([file]) => file.startsWith(`${path}/`))
        .map(([file, data]) => ({ ".tag": "file", path_lower: `/${file}`, rev: revs.get(file), size: data.length }));
      return entries.length > 0 ? json(200, { entries, has_more: false, cursor: "c" }) : notFound();
    }
    return json(400, {});
  };
  return cloud;
}

async function exercise(name: string, auth: ProviderAuth, cloud: FakeCloud): Promise<void> {
  const saved: ProviderSession[] = [];
  const session: ProviderSession = { kind: auth.kind, accessToken: "expired", refreshToken: "r1", expiresAt: Date.now() + 3_600_000 };
  const keeper = new TokenKeeper(session, auth, "client-id", async (s) => void saved.push(s), cloud.fetch);
  const folder = auth.folder(keeper, cloud.fetch);

  assert.deepEqual(await folder.list("devices"), [], `${name}: a missing folder lists empty`);
  assert.equal(saved.at(-1)?.accessToken, "fresh", `${name}: a 401 refreshed the token, and it was saved`);
  await folder.write("devices/d1/state.bin", bytes("one"));
  await folder.write("devices/d1/stats/2026-11.bin", bytes("two"));
  const listed = await folder.list("devices");
  assert.deepEqual(listed.map((e) => e.path).sort(), ["devices/d1/state.bin", "devices/d1/stats/2026-11.bin"], `${name}: recursive listing`);
  assert.ok(listed.every((e) => e.rev !== ""), `${name}: every entry has a revision`);
  assert.equal(text(await folder.read("devices/d1/state.bin")), "one", `${name}: read back`);
  assert.equal(await folder.read("devices/none.bin"), null, `${name}: a missing file is null, not an error`);
  await folder.write("devices/d1/state.bin", bytes("uno"));
  assert.equal(text(await folder.read("devices/d1/state.bin")), "uno", `${name}: overwrite`);
  await folder.remove("devices/d1/stats/2026-11.bin");
  assert.deepEqual((await folder.list("devices")).map((e) => e.path), ["devices/d1/state.bin"], `${name}: remove`);

  cloud.full = true;
  await assert.rejects(folder.write("devices/d1/big.bin", bytes("x")), QuotaError, `${name}: a full disk is reported`);
  cloud.full = false;

  const dead = new TokenKeeper(
    { kind: auth.kind, accessToken: "expired", refreshToken: "dead", expiresAt: Date.now() + 3_600_000 },
    auth, "client-id", async () => {}, cloud.fetch,
  );
  await assert.rejects(auth.folder(dead, cloud.fetch).list("devices"), AuthRequiredError, `${name}: a dead grant asks to sign in`);
}

await exercise("yandex", yandexAuth, yandexFake());
await exercise("dropbox", dropboxAuth, dropboxFake());

// Authorize URLs: PKCE S256, state, exact redirect; Dropbox asks for offline.
const { verifier, challenge } = await pkcePair();
assert.ok(verifier.length >= 43 && verifier.length <= 128, "verifier length per RFC 7636");
for (const auth of [yandexAuth, dropboxAuth]) {
  const url = new URL(auth.authorizeUrl({ clientId: "cid", challenge, state: "st", redirectUri: "https://yukireader.app/" }));
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("redirect_uri"), "https://yukireader.app/");
  assert.equal(url.searchParams.get("response_type"), "code");
}
assert.equal(new URL(dropboxAuth.authorizeUrl({ clientId: "c", challenge, state: "s", redirectUri: "r" })).searchParams.get("token_access_type"), "offline");

// The code exchange itself: verifier in, tokens out, no secret anywhere.
const exchanged = await postTokenForm(
  yandexAuth.tokenUrl,
  yandexAuth.exchangeForm({ clientId: "cid", code: "the-code", verifier, redirectUri: "https://yukireader.app/" }),
  yandexFake().fetch,
  undefined,
  "yandex",
);
assert.equal(exchanged.accessToken, "fresh");
assert.equal(exchanged.refreshToken, "r2");
assert.ok(exchanged.expiresAt > Date.now(), "expiry is tracked");

console.log("sync providers unit: all good");
