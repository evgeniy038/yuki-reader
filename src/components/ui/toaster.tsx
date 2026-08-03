import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="bottom-center"
      theme="light"
      offset={16}
      mobileOffset={{ bottom: 16, left: 12, right: 12 }}
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
