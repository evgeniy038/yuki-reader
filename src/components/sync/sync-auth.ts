import { newState, pkcePair, postTokenForm } from "@/core/sync/oauth";
import type { ProviderKind } from "@/core/sync/remote";
import { syncStore } from "@/core/sync/store";
import { createVault, inspectVault, unlockVault, VaultError, type VaultErrorCode } from "@/core/sync/vault";
import { CLIENT_IDS, PROVIDERS, redirectUri } from "./sync-config";
import { folder, patchView, syncNow } from "./sync-controller";
import { setSyncEnabled } from "./sync-signal";
import { portableState } from "@/core/sync/peer-snapshot";

/** Leave for the provider's consent page (same window: popups break in
    home-screen apps and under COOP). */
export async function connect(kind: ProviderKind): Promise<void> {
  const { verifier, challenge } = await pkcePair();
  const state = newState();
  await syncStore.setPendingAuth({ kind, state, verifier, createdAt: Date.now() });
  patchView({ phase: { kind: "authorizing", provider: kind }, signInFailed: false });
  window.location.assign(
    PROVIDERS[kind].authorizeUrl({ clientId: CLIENT_IDS[kind], challenge, state, redirectUri: redirectUri() }),
  );
}

async function exchange(code: string): Promise<boolean> {
  const pending = await syncStore.pendingAuth();
  if (!pending) return false;
  const auth = PROVIDERS[pending.kind];
  try {
    const session = await postTokenForm(
      auth.tokenUrl,
      auth.exchangeForm({ clientId: CLIENT_IDS[pending.kind], code, verifier: pending.verifier, redirectUri: redirectUri() }),
      (input, init) => fetch(input, init),
      undefined,
      pending.kind,
    );
    await syncStore.setSession(session);
    await syncStore.setPendingAuth(null);
    setSyncEnabled(true);
    await afterSignIn(pending.kind);
    return true;
  } catch {
    patchView({ signInFailed: true });
    return false;
  }
}

/** The page was opened by a provider redirect. When this storage holds the
    matching verifier, finish here; otherwise (iOS can return into a Safari
    sheet whose storage the home-screen app never sees) show the code so the
    user can paste it into the app — useless without the app's verifier. */
export async function completeRedirect(search: string): Promise<void> {
  const params = new URLSearchParams(search);
  const code = params.get("code");
  const pending = await syncStore.pendingAuth();
  if (!code) {
    await syncStore.setPendingAuth(null);
    patchView({ phase: { kind: "off" }, signInFailed: params.has("error") });
    return;
  }
  if (pending && pending.state === params.get("state")) await exchange(code);
  else patchView({ phase: { kind: "foreignCode", code } });
}

export const pasteCode = (code: string): Promise<boolean> => exchange(code.trim());

export async function afterSignIn(kind: ProviderKind): Promise<void> {
  const remote = await folder();
  if (!remote) return;
  const vault = await syncStore.vault();
  if (vault) {
    patchView({ phase: { kind: "ready", provider: kind } });
    void syncNow();
    return;
  }
  const found = await inspectVault(remote);
  if (found.kind === "vault") {
    patchView({ phase: { kind: "locked", provider: kind } });
  } else if (found.kind === "damaged") {
    patchView({ phase: { kind: "damaged", provider: kind } });
  } else {
    const created = await createVault(remote);
    await syncStore.setVault(created.binding);
    await syncStore.setRecoveryToShow(created.recoveryKey);
    patchView({ phase: { kind: "newKey", provider: kind, recoveryKey: created.recoveryKey } });
  }
}

/** "Check again" after a damaged-looking folder: inspect it once more. */
export async function recheck(): Promise<void> {
  const session = await syncStore.session();
  if (session) await afterSignIn(session.kind);
}

export async function unlock(text: string): Promise<boolean> {
  const remote = await folder();
  const session = await syncStore.session();
  if (!remote || !session) return false;
  try {
    const opened = await unlockVault(remote, text);
    const previous = await syncStore.vault();
    // A different vault than before (recreated elsewhere): start this
    // device's sync memory over as a joiner of the new one.
    if (previous && previous.id !== opened.id) await syncStore.resetVaultData();
    await syncStore.setVault(opened);
  } catch (error) {
    const code: VaultErrorCode = error instanceof VaultError ? error.code : "damaged";
    patchView({ phase: { kind: "locked", provider: session.kind, error: code } });
    return false;
  }
  patchView({ phase: { kind: "ready", provider: session.kind } });
  void syncNow();
  return true;
}

export async function confirmKeySaved(): Promise<void> {
  const session = await syncStore.session();
  await syncStore.setRecoveryToShow(null);
  if (session) patchView({ phase: { kind: "ready", provider: session.kind } });
  void syncNow();
}

/** Disconnecting an optional cloud must preserve the identity, progress
    and pairings already shared directly with another device. */
export async function forgetCloud(): Promise<void> {
  const [shadow, remotes, published, device] = await Promise.all([
    syncStore.shadow(), syncStore.remotes(), syncStore.published(), syncStore.device(),
  ]);
  if (shadow && device) {
    const portable = portableState({ v: 1, vault: "peer", seq: 0, device, ...shadow });
    await syncStore.setShadow({ ...shadow, books: portable.books });
  }
  await syncStore.setRemotes(remotes.map((entry) => ({ ...entry, state: portableState(entry.state) })));
  await Promise.all([
    syncStore.setSession(null), syncStore.setPendingAuth(null), syncStore.setVault(null),
    syncStore.setRecoveryToShow(null), syncStore.setPackManifests(new Map()),
    syncStore.setPublished({ ...published, hash: "" }), syncStore.setPublishedStats({}),
    syncStore.setPublishedCatalog(""), syncStore.setOcrApplied({}),
  ]);
}
