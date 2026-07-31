import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only knows the default theme — teach it our custom token
// names so className overrides on the official ui/ components merge
// deterministically instead of relying on CSS emission order.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "bg-color": [
        {
          bg: [
            "canvas",
            "raised",
            "muted-surface",
            "hover-surface",
            "active-surface",
            "primary-gradient",
            "scrim",
          ],
        },
      ],
      "text-color": [{ text: ["strong", "default", "muted-content"] }],
      "border-color": [{ border: ["subtle", "strong"] }],
      rounded: [{ rounded: ["media", "card", "pane", "pill", "heat"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
