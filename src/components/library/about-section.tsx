import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { changelog, type ChangelogEntry } from "@/lib/changelog";
import { cn } from "@/lib/utils";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./settings-group";

// Version + release history, folded into the bottom of Settings. Parsed from
// CHANGELOG.md at build time — the markdown file stays the only place a
// release is ever described. Collapsed a version is one header line plus its
// one-line summary; the full notes unfold on tap.
export function AboutSection() {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("settings.about.title")}>
      <SettingsRow label={t("settings.about.version")}>
        <span className="text-sm text-muted-content tabular-nums">
          {__APP_VERSION__}
        </span>
      </SettingsRow>
      <SettingsBlock>
        <ul className="flex flex-col gap-3">
          {changelog.map((entry) => (
            <ChangelogItem key={entry.version} entry={entry} />
          ))}
        </ul>
      </SettingsBlock>
    </SettingsGroup>
  );
}

function ChangelogItem({ entry }: { entry: ChangelogEntry }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("settings.about.release", { version: entry.version })}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center justify-between gap-4 text-left"
      >
        <span className="text-sm font-medium text-default tabular-nums">
          {entry.version}
          <span className="font-normal text-muted-content">
            {" "}
            · {entry.date}
          </span>
        </span>
        <CaretDown
          className={cn(
            "size-3.5 shrink-0 text-muted-content transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {entry.intro ? (
        <p className="mt-0.5 text-sm text-muted-content">{entry.intro}</p>
      ) : null}
      {open ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {entry.items.map((item) => {
            // "Lead: rest" bullets render the lead as a tiny heading — weight
            // and color only, the size stays with the body text.
            const split = item.indexOf(": ");
            const lead = split > 0 ? item.slice(0, split) : null;
            const rest = split > 0 ? item.slice(split + 2) : item;
            return (
              <li key={item} className="text-sm text-muted-content">
                {lead ? (
                  <span className="font-medium text-default">{lead}: </span>
                ) : null}
                {rest}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
