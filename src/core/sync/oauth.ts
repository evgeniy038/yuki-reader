import { randomBytes, toBase64Url } from "./crypto";
import { AuthRequiredError, type ProviderKind, type RemoteFolder } from "./remote";
import type { ProviderSession } from "./store";

// OAuth for a site with no server: authorization code + PKCE with a PUBLIC
// client (no client secret exists in the bundle — none is needed), and a
// long-lived refresh token. Only Yandex ID and Dropbox give a static page
// that combination, which is why they are the two providers: the user signs
// in once per device (Google would ask for a tap every hour, OneDrive for a
// full sign-in every day).
//
// The redirect goes to the site root (`?code=…&state=…` before the hash),
// so it never depends on SPA routing. The verifier waits in the sync
// database, not sessionStorage: on iOS the page may be reloaded on return.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderAuth {
  kind: ProviderKind;
  authorizeUrl(params: { clientId: string; challenge: string; state: string; redirectUri: string }): string;
  /** Token endpoint form fields for a code exchange / a refresh. */
  exchangeForm(params: { clientId: string; code: string; verifier: string; redirectUri: string }): Record<string, string>;
  refreshForm(params: { clientId: string; refreshToken: string }): Record<string, string>;
  tokenUrl: string;
  folder(keeper: TokenKeeper, fetchImpl: FetchLike): RemoteFolder;
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(randomBytes(32));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier) as BufferSource,
  );
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

export const newState = (): string => toBase64Url(randomBytes(16));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** POST a token-endpoint form; a 4xx from the endpoint means the grant is
    dead (revoked, expired, already used) — sign in again. */
export async function postTokenForm(
  url: string,
  form: Record<string, string>,
  fetchImpl: FetchLike,
  previous?: ProviderSession,
  kind?: ProviderKind,
): Promise<ProviderSession> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (response.status >= 400 && response.status < 500) throw new AuthRequiredError();
  if (!response.ok) throw new Error(`Token endpoint answered ${response.status}`);
  const body: unknown = await response.json();
  if (!isObject(body) || typeof body.access_token !== "string") {
    throw new Error("Token endpoint sent no access token");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
  const refreshToken =
    typeof body.refresh_token === "string" ? body.refresh_token : previous?.refreshToken;
  return {
    kind: kind ?? previous?.kind ?? "dropbox",
    accessToken: body.access_token,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/** Holds the current access token; refreshes it shortly before it expires
    or when the API rejects it, and persists every new session. */
export class TokenKeeper {
  private session: ProviderSession;
  private refreshing: Promise<ProviderSession> | null = null;

  constructor(
    session: ProviderSession,
    private readonly auth: ProviderAuth,
    private readonly clientId: string,
    private readonly persist: (session: ProviderSession) => Promise<void>,
    private readonly fetchImpl: FetchLike,
  ) {
    this.session = session;
  }

  async token(): Promise<string> {
    const expiring = this.session.expiresAt > 0 && this.session.expiresAt - Date.now() < 60_000;
    return expiring ? this.refreshed() : this.session.accessToken;
  }

  async refreshed(): Promise<string> {
    const refreshToken = this.session.refreshToken;
    if (!refreshToken) throw new AuthRequiredError();
    this.refreshing ??= postTokenForm(
      this.auth.tokenUrl,
      this.auth.refreshForm({ clientId: this.clientId, refreshToken }),
      this.fetchImpl,
      this.session,
    ).finally(() => {
      this.refreshing = null;
    });
    this.session = await this.refreshing;
    await this.persist(this.session);
    return this.session.accessToken;
  }
}

/** Run an API call with the current token; on 401 refresh once and retry. */
export async function withToken(
  keeper: TokenKeeper,
  call: (token: string) => Promise<Response>,
): Promise<Response> {
  const first = await call(await keeper.token());
  if (first.status !== 401) return first;
  return call(await keeper.refreshed());
}
