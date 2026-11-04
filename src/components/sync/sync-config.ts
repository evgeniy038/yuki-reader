import { dropboxAuth } from "@/core/sync/dropbox";
import type { DeviceApp, DeviceInfo, DevicePlatform } from "@/core/sync/model";
import type { ProviderAuth } from "@/core/sync/oauth";
import type { ProviderKind } from "@/core/sync/remote";
import { yandexAuth } from "@/core/sync/yandex";

// Build-time wiring of the sync providers and this device's identity.

export const PROVIDERS: Record<ProviderKind, ProviderAuth> = {
  yandex: yandexAuth,
  dropbox: dropboxAuth,
};

/** Public client ids (PKCE clients have no secret). Empty = not set up in
    this build — the provider stays hidden. */
export const CLIENT_IDS: Record<ProviderKind, string> = {
  yandex: import.meta.env.VITE_YANDEX_CLIENT_ID ?? "",
  dropbox: import.meta.env.VITE_DROPBOX_APP_KEY ?? "",
};

export const PROVIDER_ORDER: readonly ProviderKind[] = ["yandex", "dropbox"];

/** The exact redirect URI registered with both providers: the site root, so
    the return never depends on in-app routing. */
export function redirectUri(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`;
}

/** What this browser is, for the device list on the OTHER devices — kept
    structural so each device renders it in its own interface language. */
export function describeDevice(id: string): DeviceInfo {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  const platform: DevicePlatform = /iPhone|iPod/.test(ua)
    ? "iphone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch)
      ? "ipad"
      : /Macintosh|Mac OS X/.test(ua)
        ? "mac"
        : /Android/.test(ua)
          ? "android"
          : /Windows/.test(ua)
            ? "windows"
            : /Linux/.test(ua)
              ? "linux"
              : "other";
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    ("standalone" in navigator && navigator.standalone === true);
  const app: DeviceApp = standalone
    ? "app"
    : /Edg\//.test(ua)
      ? "edge"
      : /Firefox\//.test(ua)
        ? "firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "chrome"
          : /Safari\//.test(ua)
            ? "safari"
            : "other";
  return { id, platform, app };
}
