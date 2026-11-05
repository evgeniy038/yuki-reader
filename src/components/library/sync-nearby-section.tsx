import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deviceLabel } from "@/components/sync/sync-labels";
import * as nearby from "@/components/sync/sync-nearby";
import * as sync from "@/components/sync/sync-controller";
import * as actions from "@/components/sync/sync-actions";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./settings-group";
import { SyncTransfers, transfersOf } from "./sync-activity";

export function NearbySyncSection() {
  const { t } = useTranslation();
  const view = useSyncExternalStore(nearby.subscribeNearby, nearby.getNearbyView);
  const syncView = useSyncExternalStore(sync.subscribe, sync.getView);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try { await action(); } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  useEffect(() => { void nearby.initNearby(); }, []);
  const pair = view.pairing;
  const idle = pair.phase === "idle" || pair.phase === "error";
  const transfers = transfersOf(syncView, (stage, device) => t(`library.cloud.${stage}`, { device }), (item) => item.from ? deviceLabel(t, item.from) : "");
  const held = syncView.status?.heldDeletions ?? [];
  return (
    <SettingsGroup title={t("settings.sync.nearby.title")}>
      <SettingsBlock>
        <p className="text-xs text-muted-content">{t("settings.sync.nearby.intro")}</p>
        {idle ? (
          <div className="mt-3 flex flex-col gap-3">
            <div><Button variant="secondary" loading={busy} onClick={() => void run(nearby.createPairCode)} data-pair-create="">{t("settings.sync.nearby.create")}</Button></div>
            <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void run(() => nearby.joinPairCode(code)); }}>
              <Input className="max-w-48 font-mono uppercase" value={code} onChange={(event) => setCode(event.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={15} aria-label={t("settings.sync.nearby.code")} placeholder={t("settings.sync.nearby.code")} data-pair-input="" />
              <Button type="submit" variant="secondary" loading={busy} disabled={!code.trim()} data-pair-join="">{t("settings.sync.nearby.join")}</Button>
            </form>
          </div>
        ) : (
          <div className="mt-3 space-y-3" aria-live="polite">
            {pair.code ? <p className="select-all font-mono text-2xl tracking-wider text-default" data-pair-code="">{pair.code.slice(0, 5)}-{pair.code.slice(5)}</p> : null}
            <p className="text-sm text-muted-content">{pair.candidate ? t("settings.sync.nearby.confirm", { device: deviceLabel(t, pair.candidate) }) : t(`settings.sync.nearby.${pair.phase === "joining" ? "joining" : "waiting"}`)}</p>
            <div className="flex flex-wrap gap-2">
              {pair.phase === "confirm" ? <Button loading={busy} onClick={() => void run(nearby.confirmPair)} data-pair-confirm="">{t("settings.sync.nearby.allow")}</Button> : null}
              <Button variant="ghost" onClick={nearby.cancelPair}>{t("settings.sync.cancel")}</Button>
            </div>
          </div>
        )}
        {failed || pair.error ? <p className="mt-2 text-xs text-destructive" role="alert">{t(`settings.sync.nearby.errors.${pair.error ?? "connection"}`)}</p> : null}
      </SettingsBlock>
      {view.devices.map(({ info, connected }) => (
        <SettingsRow key={info.id}>
          <div className="min-w-0" data-paired-device={info.id} data-peer-connected={connected}>
            <span className="block text-sm text-default">{deviceLabel(t, info)}</span>
            <span className="block text-xs text-muted-content">{t(`settings.sync.nearby.${connected ? "connected" : "offline"}`)}</span>
          </div>
          <Button variant="ghost" onClick={() => void run(() => nearby.forgetNearby(info.id))}>{t("settings.sync.nearby.forget")}</Button>
        </SettingsRow>
      ))}
      {view.devices.length > 0 ? <SettingsRow><span className="text-xs text-muted-content">{t("settings.sync.nearby.keepOpen")}</span><Button variant="secondary" loading={syncView.syncing} onClick={() => void sync.syncNow()} data-nearby-sync-now="">{t("settings.sync.syncNow")}</Button></SettingsRow> : null}
      {transfers.length > 0 && syncView.phase.kind !== "ready" ? <SettingsBlock><SyncTransfers transfers={transfers} /></SettingsBlock> : null}
      {held.length > 0 && syncView.phase.kind !== "ready" ? <SettingsBlock>
        <p className="text-sm text-default">{t("settings.sync.held", { count: held.length })}</p>
        <div className="mt-3 flex gap-2">
          <Button variant="destructive" onClick={() => void actions.resolveHeldDeletions(true)}>{t("settings.sync.heldDelete")}</Button>
          <Button variant="secondary" onClick={() => void actions.resolveHeldDeletions(false)}>{t("settings.sync.heldKeep")}</Button>
        </div>
      </SettingsBlock> : null}
    </SettingsGroup>
  );
}
