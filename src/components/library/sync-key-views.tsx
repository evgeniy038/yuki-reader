import { useState, type FormEvent } from "react";
import { Copy, DownloadSimple, Key } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { VaultErrorCode } from "@/core/sync/vault";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingsBlock } from "./settings-group";

// The recovery-key moments of the Sync group: showing a new key once,
// unlocking with it on another device, and the sign-in code fallbacks.

const keyFont = "font-mono text-sm tracking-wide text-strong";

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    // Clipboard denied: the key stays visible and selectable.
  }
}

/** A new vault's key, shown once. "Save to Passwords" is a real login form
    (username "yuki", the key as the password): Safari and Chrome offer to
    keep it, and AutoFill brings it back on the next device. */
export function NewKeyView({
  recoveryKey,
  provider,
  onDone,
}: {
  recoveryKey: string;
  provider: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);

  const saveToPasswords = (event: FormEvent) => {
    event.preventDefault();
    // Chrome stores programmatically; Safari offers on the form submit.
    if (typeof PasswordCredential !== "undefined") {
      const credential = new PasswordCredential({ id: "yuki", password: recoveryKey, name: "yuki" });
      void navigator.credentials.store(credential).catch(() => {});
    }
  };

  const download = () => {
    const blob = new Blob([`yuki — ${t("settings.sync.keyTitle")}\n\n${recoveryKey}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "yuki-recovery-key.txt";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <SettingsBlock>
      <div className="flex flex-col gap-3" data-sync-new-key="">
        <div className="flex items-center gap-2 text-sm font-medium text-strong">
          <Key className="size-4 text-primary" />
          {t("settings.sync.keyTitle")}
        </div>
        <p className="text-xs text-muted-content">{t("settings.sync.keyHint", { provider })}</p>
        <code data-sync-key="" className={`${keyFont} select-all break-all rounded-lg bg-muted-surface px-3 py-2`}>
          {recoveryKey}
        </code>
        <form onSubmit={saveToPasswords} className="flex flex-col gap-3">
          {/* The password manager looks for a submitted login form: the key
              rides along as its (visually hidden) password. */}
          <input type="text" name="username" autoComplete="username" value="yuki" readOnly className="sr-only" tabIndex={-1} aria-hidden />
          <input type="password" name="password" autoComplete="new-password" value={recoveryKey} readOnly className="sr-only" tabIndex={-1} aria-hidden />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary">
              <Key />
              {t("settings.sync.keySave")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => void copyText(recoveryKey, t("settings.sync.copied"))}>
              <Copy />
              {t("settings.sync.copy")}
            </Button>
            <Button type="button" variant="secondary" onClick={download}>
              <DownloadSimple />
              {t("settings.sync.keyDownload")}
            </Button>
          </div>
        </form>
        <div className="flex items-center gap-3 text-sm text-default">
          <Switch checked={saved} onCheckedChange={setSaved} ariaLabel={t("settings.sync.keySavedCheck")} />
          {t("settings.sync.keySavedCheck")}
        </div>
        <div>
          <Button disabled={!saved} onClick={onDone} data-sync-key-done="">
            {t("settings.sync.done")}
          </Button>
        </div>
      </div>
    </SettingsBlock>
  );
}

/** Another device: open the library with the recovery key. A login form, so
    Passwords can fill the key in from the first device. */
export function UnlockView({
  error,
  onUnlock,
  onForgot,
}: {
  error?: VaultErrorCode;
  onUnlock: (key: string) => Promise<boolean>;
  onForgot: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await onUnlock(value);
    setBusy(false);
  };
  return (
    <SettingsBlock>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <div className="text-sm font-medium text-strong">{t("settings.sync.unlockTitle")}</div>
        <p className="text-xs text-muted-content">{t("settings.sync.unlockHint")}</p>
        <input type="text" name="username" autoComplete="username" value="yuki" readOnly hidden />
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          autoCapitalize="characters"
          spellCheck={false}
          value={value}
          placeholder={t("settings.sync.unlockPlaceholder")}
          onChange={(event) => setValue(event.target.value)}
          data-sync-unlock-input=""
          className={keyFont}
        />
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {t(`settings.sync.errors.${error}`)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={busy} disabled={value.trim() === ""} data-sync-unlock="">
            {t("settings.sync.unlock")}
          </Button>
          <Button type="button" variant="ghost" onClick={onForgot}>
            {t("settings.sync.forgot")}
          </Button>
        </div>
      </form>
    </SettingsBlock>
  );
}

/** Waiting on the provider; if the sign-in page came back elsewhere (iOS
    sheet), the code it shows can be pasted here. */
export function AuthorizingView({
  provider,
  failed,
  onPaste,
  onCancel,
}: {
  provider: string;
  failed: boolean;
  onPaste: (code: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  return (
    <SettingsBlock>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onPaste(code);
        }}
      >
        <p className="text-sm text-default">{t("settings.sync.waiting", { provider })}</p>
        <p className="text-xs text-muted-content">{t("settings.sync.pasteHint")}</p>
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t("settings.sync.pastePlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className={keyFont}
        />
        {failed ? <p className="text-xs text-destructive">{t("settings.sync.signInFailed")}</p> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={code.trim() === ""}>
            {t("settings.sync.pasteContinue")}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("settings.sync.cancel")}
          </Button>
        </div>
      </form>
    </SettingsBlock>
  );
}

/** This page holds a sign-in code that belongs to the app elsewhere. */
export function ForeignCodeView({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <SettingsBlock>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-default">{t("settings.sync.foreignCode")}</p>
        <code className={`${keyFont} break-all rounded-lg bg-muted-surface px-3 py-2`}>{code}</code>
        <div>
          <Button variant="secondary" onClick={() => void copyText(code, t("settings.sync.copied"))}>
            <Copy />
            {t("settings.sync.copy")}
          </Button>
        </div>
      </div>
    </SettingsBlock>
  );
}
