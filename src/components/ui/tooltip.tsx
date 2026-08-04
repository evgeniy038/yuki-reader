import type { ReactElement, ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";

// Base UI tooltip: `content` anchored to `trigger` — the render element
// itself (a heatmap cell, an icon). Wrap several tooltips in a
// TooltipProvider so that once one is open, the neighbours open instantly.
// Escape closes (base-ui), hover-out closes with no delay.
export function Tooltip({
  trigger,
  content,
  side = "top",
  sideOffset = 6,
  delay = 50,
}: {
  trigger: ReactElement;
  content: ReactNode;
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: number;
  delay?: number;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={trigger} delay={delay} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          side={side}
          sideOffset={sideOffset}
          className="z-50"
        >
          <TooltipPrimitive.Popup
            data-slot="tooltip-popup"
            className={cn(
              "rounded-pane border border-subtle bg-raised px-3 py-2 text-xs text-default shadow-floating outline-none",
              // Entrance/exit: fade + 2px toward the trigger. base-ui mounts
              // the popup with data-starting-style and holds data-closed on
              // the way out until the transition settles, so both states get
              // the hidden pose; direction follows the (possibly flipped) side.
              "transition-all duration-120 ease-out",
              "data-open:opacity-100 data-open:translate-y-0",
              "data-closed:opacity-0 data-starting-style:opacity-0",
              "data-[side=top]:data-closed:translate-y-0.5 data-[side=top]:data-starting-style:translate-y-0.5",
              "data-[side=bottom]:data-closed:-translate-y-0.5 data-[side=bottom]:data-starting-style:-translate-y-0.5",
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
