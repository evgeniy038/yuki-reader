import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Page composition for every view (library, stats, settings) — children-only,
// shadcn style. PageShell sets the shared rhythm (max width, equal padding on
// all sides; the deep bottom padding keeps the last row clear of the floating
// nav pill). PageHeader is ALWAYS a 32px row (min-h-8), with or without
// actions, so every page's content starts at the same offset; the title is
// leading-none and taller controls (h-8) center around its line — text aligns
// with text. PageSectionTitle is the single subhead style inside a page.
// PageContent carries the body.
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col px-6 pt-3.5 pb-24">
      {children}
    </div>
  );
}

export function PageHeader({ children }: { children: ReactNode }) {
  return (
    <header className="mb-6 flex min-h-8 items-center gap-4">{children}</header>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-base leading-none font-medium text-strong tabular-nums">
      {children}
    </h1>
  );
}

export function PageSectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-sm text-default tabular-nums">{children}</h2>;
}

export function PageActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex items-center gap-2">{children}</div>;
}

export function PageContent({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {children}
    </div>
  );
}
