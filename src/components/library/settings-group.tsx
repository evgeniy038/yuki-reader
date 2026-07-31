import { Children, type ReactElement, type ReactNode } from "react";

// macOS System Settings-style group: a small heading above a rounded-card
// (16px) card, rows inside separated by hairlines. The card is borderless —
// lightest
// shadow (shadow-card) lifts it off the canvas, borders made the page feel
// dense. The heading is inset to the end of the
// card's corner rounding (pl-4 = the card radius), as in macOS; its row
// is always 32px tall (min-h-8) so sections keep the same rhythm with or
// without actions. Separators are inset from both edges (mx-4) — they sit
// centered between the card's sides; they are inserted automatically between
// rows, except after a SettingsBlock (its nested container already draws the
// boundary). Every row is
// the same 48px height (min-h-12): controls differ (segmented, stepper,
// slider), so the row owns the rhythm and centers its control.
export function SettingsGroup({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const rows = Children.toArray(children);
  return (
    <section>
      <div className="mb-2 flex min-h-8 items-center gap-4 pl-4">
        <h2 className="text-sm text-default tabular-nums">{title}</h2>
        {actions ? (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <div className="rounded-card bg-raised shadow-card">
        {rows.flatMap((row, index) => {
          const prev = rows[index - 1];
          const afterBlock =
            prev !== undefined &&
            (prev as ReactElement).type === SettingsBlock;
          return index === 0 || afterBlock
            ? [row]
            : [
                <div
                  key={`sep-${index}`}
                  aria-hidden
                  className="mx-4 border-t border-subtle"
                />,
                row,
              ];
        })}
      </div>
    </section>
  );
}

// Free-form content in a group's row area that is not a labeled row (the
// reading preview): same insets as a row, and the group does not draw a
// hairline after it — the block's own nested container marks the boundary.
export function SettingsBlock({ children }: { children: ReactNode }) {
  return <div className="px-4 py-3">{children}</div>;
}

export function SettingsRow({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-1.5">
      {label ? <span className="text-sm text-default">{label}</span> : null}
      {children}
    </div>
  );
}
