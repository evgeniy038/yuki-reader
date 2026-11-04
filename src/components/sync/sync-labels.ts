import type { TFunction } from "i18next";
import type { DeviceInfo } from "@/core/sync/model";

/** "iPhone · app", "Mac · Chrome" — in this device's interface language. */
export function deviceLabel(t: TFunction, device: DeviceInfo): string {
  return `${t(`sync.platform.${device.platform}`)} · ${t(`sync.app.${device.app}`)}`;
}
