import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
  const transfers = transfersOf(syncView, (stage, device) => t(`library.cloud.${stage}`, { device }), (item) => item.from ? deviceLabel(t, item.from) : "");
  const held = syncView.heldDeletions;
  return (
    <>
      <SettingsGroup title={t("settings.sync.nearby.title")}>
        <SettingsBlock>
          <Button variant="secondary" disabled={busy} onClick={() => { setCode(""); void run(nearby.createPairCode); }} data-pair-create="">{t("settings.sync.nearby.create")}</Button>
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
        {transfers.length > 0 && syncView.phase.kind !== "ready" ? <SettingsBlock><SyncTransfers transfers={transfers} /></SettingsBlock> : null}
        {held.length > 0 && syncView.phase.kind !== "ready" ? <SettingsBlock>
          <p className="text-sm text-default">{t("settings.sync.held", { count: held.length })}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="destructive" onClick={() => void actions.resolveHeldDeletions(true)}>{t("settings.sync.heldDelete")}</Button>
            <Button variant="secondary" onClick={() => void actions.resolveHeldDeletions(false)}>{t("settings.sync.heldKeep")}</Button>
          </div>
        </SettingsBlock> : null}
      </SettingsGroup>
      <Dialog open={pair.phase !== "idle"} onOpenChange={(open) => { if (!open) nearby.cancelPair(); }}>
        <DialogContent>
          <DialogTitle>{t("settings.sync.nearby.create")}</DialogTitle>
          {pair.phase === "confirm" && pair.candidate ? (
            <>
              <p className="text-sm text-default">{t("settings.sync.nearby.confirm", { device: deviceLabel(t, pair.candidate) })}</p>
              <Button loading={busy} onClick={() => void run(nearby.confirmPair)} data-pair-confirm="">{t("settings.sync.nearby.allow")}</Button>
            </>
          ) : pair.phase === "joining" ? (
            <p className="text-sm text-muted-content" role="status">{t("settings.sync.nearby.joining")}</p>
          ) : (
            <>
              {pair.code ? <div>
                <p className="mb-2 text-xs text-muted-content">{t("settings.sync.nearby.ownCode")}</p>
                <p className="select-all font-mono text-2xl tracking-wider text-default" data-pair-code="">{pair.code.slice(0, 5)}-{pair.code.slice(5)}</p>
              </div> : <Button variant="secondary" loading={busy} onClick={() => void run(nearby.createPairCode)}>{t("settings.sync.nearby.newCode")}</Button>}
              <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void run(() => nearby.joinPairCode(code)); }}>
                <Input className="min-w-0 flex-1" value={code} onChange={(event) => setCode(event.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={15} aria-label={t("settings.sync.nearby.code")} placeholder={t("settings.sync.nearby.code")} data-pair-input="" />
                <Button type="submit" disabled={busy || !code.trim()} data-pair-join="">{t("settings.sync.nearby.join")}</Button>
              </form>
            </>
          )}
          {failed || pair.error ? <p className="text-xs text-destructive" role="alert">{t(`settings.sync.nearby.errors.${pair.error ?? "connection"}`)}</p> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
