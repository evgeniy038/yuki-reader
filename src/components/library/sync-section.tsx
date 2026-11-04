import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowsClockwise, CloudCheck, CloudSlash, CloudArrowUp } from "@/components/ui/icons";
import { useTranslation } from "react-i18next";
import * as sync from "@/components/sync/sync-controller";
import { CLIENT_IDS, PROVIDER_ORDER } from "@/components/sync/sync-config";
import { deviceLabel } from "@/components/sync/sync-labels";
import { formatBytes, formatNumber, formatTimeAgo } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./settings-group";
import { AuthorizingView, ForeignCodeView, NewKeyView, UnlockView } from "./sync-key-views";

// Settings → Sync: connect a cloud, keep the recovery key, see what synced
// and when, list the devices. Honest numbers in the status line — a "synced"
// badge with nothing behind it cost Koodo its users' trust.

const UNDO_WINDOW_MS = 7 * 86_400_000;

type Confirm = "startOver" | "disconnect" | null;

export function SyncSection() {
  const { t } = useTranslation();
  const view = useSyncExternalStore(sync.subscribe, sync.getView);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    void sync.init();
    // Keep "synced 2 min ago" fresh while the page is open.
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const phase = view.phase;
  const providerName = (kind: "yandex" | "dropbox") => t(`settings.sync.provider.${kind}`);
  const available = PROVIDER_ORDER.filter((kind) => CLIENT_IDS[kind] !== "");

  // SettingsGroup draws hairlines between its direct children, so every
  // state is a keyed list of rows rather than one fragment.
  let rows: ReactNode[];
  switch (phase.kind) {
    case "off":
      rows = [
        <SettingsBlock key="intro">
          <p className="text-xs text-muted-content">{t("settings.sync.intro")}</p>
          {view.signInFailed ? <p className="mt-2 text-xs text-destructive">{t("settings.sync.signInFailed")}</p> : null}
        </SettingsBlock>,
        ...(available.length === 0
          ? [
              <SettingsRow key="none">
                <span className="text-sm text-muted-content">{t("settings.sync.notConfigured")}</span>
              </SettingsRow>,
            ]
          : available.map((kind) => (
              <SettingsRow key={kind} label={providerName(kind)}>
                <Button variant="secondary" onClick={() => void sync.connect(kind)} data-sync-connect={kind}>
                  <CloudArrowUp />
                  {t("settings.sync.connect", { provider: providerName(kind) })}
                </Button>
              </SettingsRow>
            ))),
      ];
      break;
    case "authorizing":
      rows = [
        <AuthorizingView
          key="auth"
          provider={providerName(phase.provider)}
          failed={view.signInFailed === true}
          onPaste={sync.pasteCode}
          onCancel={() => void sync.disconnect()}
        />,
      ];
      break;
    case "foreignCode":
      rows = [<ForeignCodeView key="code" code={phase.code} />];
      break;
    case "newKey":
      rows = [
        <NewKeyView
          key="key"
          recoveryKey={phase.recoveryKey}
          provider={providerName(phase.provider)}
          onDone={() => void sync.confirmKeySaved()}
        />,
      ];
      break;
    case "locked":
      rows = [<UnlockView key="unlock" error={phase.error} onUnlock={sync.unlock} onForgot={() => setConfirm("startOver")} />];
      break;
    case "damaged":
      rows = [
        <SettingsBlock key="damaged">
          <p className="text-sm text-default">{t("settings.sync.damaged")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void sync.recheck()}>
              {t("settings.sync.recheck")}
            </Button>
            <Button variant="destructive" onClick={() => setConfirm("startOver")}>
              {t("settings.sync.startOver")}
            </Button>
          </div>
        </SettingsBlock>,
      ];
      break;
    case "ready": {
      const status = view.status;
      const held = status?.heldDeletions ?? [];
      const statusLine = view.syncing
        ? t("settings.sync.syncing")
        : !status
          ? t("settings.sync.never")
          : status.ok
            ? t("settings.sync.synced", { when: formatTimeAgo(status.at) })
            : t(`settings.sync.error.${status.error ?? "unknown"}`, { provider: providerName(phase.provider) });
      rows = [
          <SettingsRow key="status">
            <div className="flex min-w-0 items-center gap-3" data-sync-status={status?.ok === false ? "error" : "ok"}>
              {status?.ok === false ? (
                <CloudSlash className="size-4 shrink-0 text-destructive" />
              ) : (
                <CloudCheck className="size-4 shrink-0 text-primary" />
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm text-default">{statusLine}</span>
                {status?.ok ? (
                  <span className="block truncate text-xs text-muted-content">
                    {t("settings.sync.syncedDetail", {
                      sent: formatNumber(status.sent),
                      received: formatNumber(status.received),
                      size: formatBytes(status.bytes),
                    })}
                  </span>
                ) : null}
              </span>
            </div>
            {status?.error === "auth" ? (
              <Button variant="secondary" onClick={() => void sync.connect(phase.provider)}>
                {t("settings.sync.signInAgain")}
              </Button>
            ) : (
              <Button variant="secondary" loading={view.syncing} onClick={() => void sync.syncNow()} data-sync-now="">
                <ArrowsClockwise />
                {t("settings.sync.syncNow")}
              </Button>
            )}
          </SettingsRow>,
          ...(held.length > 0 ? [
            <SettingsBlock key="held">
              <p className="text-sm text-default">{t("settings.sync.held", { count: held.length })}</p>
              <div className="mt-3 flex gap-2">
                <Button variant="destructive" onClick={() => void sync.resolveHeldDeletions(true)}>
                  {t("settings.sync.heldDelete")}
                </Button>
                <Button variant="secondary" onClick={() => void sync.resolveHeldDeletions(false)}>
                  {t("settings.sync.heldKeep")}
                </Button>
              </div>
            </SettingsBlock>,
          ] : []),
          <SettingsBlock key="devices">
            <h3 className="text-xs text-muted-content">{t("settings.sync.devices")}</h3>
            <ul className="mt-2 flex flex-col gap-1" data-sync-devices="">
              {view.devices.map((device) => (
                <li key={device.info.id} className="text-sm text-default">
                  {deviceLabel(t, device.info)}
                  {device.self ? <span className="text-muted-content"> · {t("settings.sync.thisDevice")}</span> : null}
                </li>
              ))}
            </ul>
          </SettingsBlock>,
          ...(view.snapshotAt !== undefined && Date.now() - view.snapshotAt < UNDO_WINDOW_MS ? [
            <SettingsRow key="undo" label={t("settings.sync.undoHint")}>
              <Button variant="secondary" onClick={() => void sync.undoFirstSync()}>
                {t("settings.sync.undo")}
              </Button>
            </SettingsRow>,
          ] : []),
          <SettingsRow key="disconnect">
            <Button variant="ghost" onClick={() => setConfirm("disconnect")}>
              {t("settings.sync.disconnect")}
            </Button>
          </SettingsRow>,
      ];
      break;
    }
  }

  return (
    <>
      <SettingsGroup title={t("settings.sync.title")}>{rows}</SettingsGroup>
      <ConfirmDialog
        open={confirm === "startOver"}
        title={t("settings.sync.startOverTitle")}
        body={t("settings.sync.startOverBody")}
        confirmLabel={t("settings.sync.startOver")}
        onConfirm={() => void sync.startOver()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "disconnect"}
        title={t("settings.sync.disconnectTitle")}
        body={t("settings.sync.disconnectBody")}
        confirmLabel={t("settings.sync.disconnect")}
        onConfirm={() => void sync.disconnect()}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}
