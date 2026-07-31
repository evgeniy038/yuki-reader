import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

// macOS/iOS-style toggle: gray track off, primary gradient on, white knob
// slides. For binary settings (furigana on/off, ...).
export function Switch({
  checked,
  onCheckedChange,
  ariaLabel,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      aria-label={ariaLabel}
      disabled={disabled}
      className="relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full bg-hover-surface p-0.5 transition-colors data-[checked]:bg-primary-gradient data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40"
    >
      <SwitchPrimitive.Thumb className="size-4 rounded-full bg-white shadow-card transition-transform data-[checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
