import { withToken, type FetchLike, type ProviderAuth, type TokenKeeper } from "./oauth";
import { QuotaError, type RemoteEntry, type RemoteFolder } from "./remote";

// Dropbox, "App folder" access: the app sees only /Apps/<app name>, which is
// its root ("/devices/…" here). PKCE with token_access_type=offline gives a
// refresh token that never expires on its own — one sign-in per device.
// Every host (api, content, the token endpoint) answers CORS. Dropbox
// creates parent folders on upload by itself.

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const NOTIFY = "https://notify.dropboxapi.com/2/files/list_folder/longpoll";
/** Dropbox's own long-poll timeout, and ours on top: a VPN or proxy can drop
    an idle connection without closing it, and a long-poll that never comes
    back would leave this device deaf to the others. */
const LONGPOLL_S = 30;
const LONGPOLL_GUARD_MS = (LONGPOLL_S + 15) * 1000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export const dropboxAuth: ProviderAuth = {
  kind: "dropbox",
  tokenUrl: "https://api.dropboxapi.com/oauth2/token",
  authorizeUrl: ({ clientId, challenge, state, redirectUri }) =>
    `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",
      redirect_uri: redirectUri,
      state,
    }).toString()}`,
  exchangeForm: ({ clientId, code, verifier, redirectUri }) => ({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }),
  refreshForm: ({ clientId, refreshToken }) => ({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  }),
  folder: (keeper, fetchImpl) => new DropboxFolder(keeper, fetchImpl),
};

/** Dropbox reports "no such path" as a 409 with a tagged error body. */
async function notFound(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const text = await response.clone().text();
  return text.includes("not_found");
}

class DropboxFolder implements RemoteFolder {
  readonly kind = "dropbox";

  constructor(
    private readonly keeper: TokenKeeper,
    private readonly fetchImpl: FetchLike,
  ) {}

  private rpc(endpoint: string, arg: unknown): Promise<Response> {
    return withToken(this.keeper, (token) =>
      this.fetchImpl(`${API}/${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(arg),
      }),
    );
  }

  private async fail(response: Response, what: string): Promise<never> {
    const text = await response.clone().text();
    if (response.status === 507 || text.includes("insufficient_space")) throw new QuotaError();
    throw new Error(`Dropbox ${what}: ${response.status}`);
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    let response = await this.rpc("files/list_folder", {
      path: `/${dir}`,
      recursive: true,
      include_deleted: false,
    });
    for (;;) {
      if (await notFound(response)) return out;
      if (!response.ok) await this.fail(response, "list");
      const body: unknown = await response.json();
      if (!isObject(body) || !Array.isArray(body.entries)) throw new Error("Dropbox sent a bad listing");
      for (const entry of body.entries) {
        if (!isObject(entry) || entry[".tag"] !== "file" || typeof entry.path_lower !== "string") continue;
        out.push({
          path: entry.path_lower.replace(/^\//, ""),
          rev: typeof entry.rev === "string" ? entry.rev : "",
          size: typeof entry.size === "number" ? entry.size : 0,
        });
      }
      if (body.has_more !== true || typeof body.cursor !== "string") return out;
      response = await this.rpc("files/list_folder/continue", { cursor: body.cursor });
    }
  }

  async watch(dir: string): Promise<(signal: AbortSignal) => Promise<void>> {
    const cursorFor = () => this.rpc("files/list_folder/get_latest_cursor", { path: `/${dir}`, recursive: true });
    let response = await cursorFor();
    if (await notFound(response)) {
      await this.rpc("files/create_folder_v2", { path: `/${dir}`, autorename: false });
      response = await cursorFor();
    }
    if (!response.ok) await this.fail(response, "watch");
    const body: unknown = await response.json();
    if (!isObject(body) || typeof body.cursor !== "string") throw new Error("Dropbox sent no cursor");
    const cursor = body.cursor;
    return async (signal) => {
      const guard = new AbortController();
      const stop = () => guard.abort();
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, LONGPOLL_GUARD_MS);
      try {
        // The long-poll takes no token; a plain-text body keeps it a simple
        // request (Dropbox's documented browser path, no preflight).
        const poll = await this.fetchImpl(NOTIFY, {
          method: "POST",
          headers: { "Content-Type": "text/plain; charset=dropbox-cors-hack" },
          body: JSON.stringify({ cursor, timeout: LONGPOLL_S }),
          signal: guard.signal,
        }).catch((error: unknown) => {
          if (signal.aborted) throw error;
          return null; // our guard gave up on a silent connection: look again
        });
        const result: unknown = poll ? await poll.json().catch(() => null) : null;
        const backoff = isObject(result) && typeof result.backoff === "number" ? result.backoff : 0;
        if (backoff > 0) await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    };
  }

  async read(path: string): Promise<Uint8Array | null> {
    const response = await withToken(this.keeper, (token) =>
      this.fetchImpl(`${CONTENT}/files/download`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: `/${path}` }) },
      }),
    );
    if (await notFound(response)) return null;
    if (!response.ok) await this.fail(response, "download");
    return new Uint8Array(await response.arrayBuffer());
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const response = await withToken(this.keeper, (token) =>
      this.fetchImpl(`${CONTENT}/files/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({ path: `/${path}`, mode: "overwrite", mute: true }),
        },
        body: new Blob([bytes as BlobPart]),
      }),
    );
    if (!response.ok) await this.fail(response, "upload");
  }

  async remove(path: string): Promise<void> {
    const response = await this.rpc("files/delete_v2", { path: `/${path}` });
    if (!response.ok && !(await notFound(response))) await this.fail(response, "delete");
  }
}
