/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

// Injected by vite.config.ts from package.json at build time.
declare const __APP_VERSION__: string;

// Public OAuth client ids of the sync providers (no secrets exist — PKCE).
// Set at build time; an unset id hides that provider in Settings.
interface ImportMetaEnv {
  readonly VITE_YANDEX_CLIENT_ID?: string;
  readonly VITE_DROPBOX_APP_KEY?: string;
}

// Credential Management (Chromium only): a programmatic "save password"
// prompt — the recovery key goes into the browser's password manager.
// Absent in Safari, hence `| undefined` and a typeof guard at the call site.
interface PasswordCredentialData {
  id: string;
  password: string;
  name?: string;
}
declare const PasswordCredential: (new (data: PasswordCredentialData) => Credential) | undefined;
