import { withToken, type FetchLike, type ProviderAuth, type TokenKeeper } from "./oauth";
import { QuotaError, type RemoteEntry, type RemoteFolder } from "./remote";

// Yandex Disk, app-folder scope (cloud_api:disk.app_folder): the app sees
// only «Приложения/<app name>», addressed as "app:/…". Yandex ID swaps the
// code for tokens with PKCE alone (no secret), and its token is renewed on
// every use — the user signs in once. Works from Russia without a VPN.
// Upload and download go through one-off hrefs on Yandex's storage hosts;
// those take NO Authorization header (the API docs say the href is enough,
// and the download host's CORS allows plain GETs).

const API = "https://cloud-api.yandex.net/v1/disk/resources";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const appPath = (path: string): string => `app:/${path}`;

export const yandexAuth: ProviderAuth = {
  kind: "yandex",
  tokenUrl: "https://oauth.yandex.ru/token",
  authorizeUrl: ({ clientId, challenge, state, redirectUri }) =>
    `https://oauth.yandex.ru/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      state,
    }).toString()}`,
  exchangeForm: ({ clientId, code, verifier }) => ({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: verifier,
  }),
  refreshForm: ({ clientId, refreshToken }) => ({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  }),
  folder: (keeper, fetchImpl) => new YandexFolder(keeper, fetchImpl),
};

class YandexFolder implements RemoteFolder {
  readonly kind = "yandex";
  private readonly madeDirs = new Set<string>();

  constructor(
    private readonly keeper: TokenKeeper,
    private readonly fetchImpl: FetchLike,
  ) {}

  private api(method: string, url: string): Promise<Response> {
    return withToken(this.keeper, (token) =>
      this.fetchImpl(url, { method, headers: { Authorization: `OAuth ${token}` } }),
    );
  }

  private async fail(response: Response, what: string): Promise<never> {
    if (response.status === 507) throw new QuotaError();
    throw new Error(`Yandex Disk ${what}: ${response.status}`);
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (let offset = 0; ; offset += 1000) {
        const query = new URLSearchParams({
          path: appPath(relative),
          limit: "1000",
          offset: String(offset),
          fields: "_embedded.items.name,_embedded.items.type,_embedded.items.md5,_embedded.items.modified,_embedded.items.size,_embedded.total",
        });
        const response = await this.api("GET", `${API}?${query.toString()}`);
        if (response.status === 404) return;
        if (!response.ok) await this.fail(response, "list");
        const body: unknown = await response.json();
        const embedded = isObject(body) && isObject(body._embedded) ? body._embedded : undefined;
        const items = embedded && Array.isArray(embedded.items) ? embedded.items : [];
        for (const item of items) {
          if (!isObject(item) || typeof item.name !== "string") continue;
          const path = `${relative}/${item.name}`;
          if (item.type === "dir") {
            await walk(path);
          } else {
            const md5 = typeof item.md5 === "string" ? item.md5 : "";
            const modified = typeof item.modified === "string" ? item.modified : "";
            const size = typeof item.size === "number" ? item.size : 0;
            out.push({ path, rev: `${md5}/${modified}`, size });
          }
        }
        const total = embedded && typeof embedded.total === "number" ? embedded.total : items.length;
        if (offset + 1000 >= total) return;
      }
    };
    await walk(dir);
    return out;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const query = new URLSearchParams({ path: appPath(path) });
    const response = await this.api("GET", `${API}/download?${query.toString()}`);
    if (response.status === 404) return null;
    if (!response.ok) await this.fail(response, "download link");
    const body: unknown = await response.json();
    if (!isObject(body) || typeof body.href !== "string") throw new Error("Yandex Disk sent no download link");
    const file = await this.fetchImpl(body.href, { method: "GET" });
    if (file.status === 404) return null;
    if (!file.ok) await this.fail(file, "download");
    return new Uint8Array(await file.arrayBuffer());
  }

  private async ensureDir(dir: string): Promise<void> {
    const parts = dir.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      const path = parts.slice(0, i).join("/");
      if (this.madeDirs.has(path)) continue;
      const query = new URLSearchParams({ path: appPath(path) });
      const response = await this.api("PUT", `${API}?${query.toString()}`);
      // 201 created; 409 already there — both mean the folder exists.
      if (!response.ok && response.status !== 409) await this.fail(response, "mkdir");
      this.madeDirs.add(path);
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash > 0) await this.ensureDir(path.slice(0, slash));
    const query = new URLSearchParams({ path: appPath(path), overwrite: "true" });
    const response = await this.api("GET", `${API}/upload?${query.toString()}`);
    if (!response.ok) await this.fail(response, "upload link");
    const body: unknown = await response.json();
    if (!isObject(body) || typeof body.href !== "string") throw new Error("Yandex Disk sent no upload link");
    const upload = await this.fetchImpl(body.href, {
      method: typeof body.method === "string" ? body.method : "PUT",
      body: new Blob([bytes as BlobPart]),
    });
    if (!upload.ok) await this.fail(upload, "upload");
  }

  async remove(path: string): Promise<void> {
    const query = new URLSearchParams({ path: appPath(path), permanently: "true" });
    const response = await this.api("DELETE", `${API}?${query.toString()}`);
    if (!response.ok && response.status !== 404) await this.fail(response, "delete");
  }
}
