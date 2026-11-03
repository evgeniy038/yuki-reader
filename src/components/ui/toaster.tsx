import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="top-center"
      theme="light"
      offset={{ top: "calc(env(safe-area-inset-top, 0px) + 16px)" }}
      mobileOffset={{
        top: "calc(env(safe-area-inset-top, 0px) + 12px)",
        left: 12,
        right: 12,
      }}
      duration={3000}
      gap={8}
      visibleToasts={1}
      closeButton={false}
      toastOptions={{
        style: {
          background: "var(--ds-surface-raised)",
          border: "1px solid var(--ds-border-subtle)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-floating)",
          color: "var(--ds-content-strong)",
          fontFamily: "var(--font-sans)",
          width: "fit-content",
          maxWidth: "calc(100vw - 24px)",
          padding: "10px 12px",
        },
        classNames: {
          title: "text-sm font-medium text-strong",
          icon: "text-primary",
        },
      }}
    />
  );
}
