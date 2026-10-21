import type { CSSProperties } from "react";

// A small square of the item's colour next to each line, so buyers and the
// seller recognise an order at a glance. Prints get a pattern, not a flat fill.

const SOLID: Record<string, string> = {
  Blue: "#3f6fd8",
  Sage: "#9db59a",
  White: "#f3f1ea",
  Pink: "#f2a7bd",
  Black: "#2a2a2a",
  Beige: "#d8c3a2",
  Navy: "#23305e",
  Maroon: "#7a2333",
  Cream: "#efe5cf",
  Oat: "#d9cbb0",
  Grey: "#9a9aa3",
  Natural: "#c8a265",
  Paisley: "#b0653c",
};

const PATTERNS: Record<string, CSSProperties> = {
  Floral: {
    background:
      "radial-gradient(circle, #fff 0 2px, transparent 3px) 0 0/9px 9px, radial-gradient(circle, #b5446a 0 1.5px, transparent 2.5px) 4.5px 4.5px/9px 9px, #d9a3b5",
  },
};

export function swatchFor(color: string | null) {
  return (color && SOLID[color]) ?? "#c9bfae";
}

export function swatchStyle(color: string | null): CSSProperties {
  if (color && PATTERNS[color]) return PATTERNS[color];
  const fill = swatchFor(color);
  return { background: fill, boxShadow: fill === SOLID.White ? "inset 0 0 0 1px #e7e1d7" : "" };
}

/** A product's colours side by side, for the seller's product list. */
export function productSwatch(colors: string[]): CSSProperties {
  if (colors.length === 0) return { background: "#c9bfae" };
  const first = colors[0] ?? null;
  if (colors.length === 1) return swatchStyle(first);
  const step = 100 / colors.length;
  const stops = colors.map((c, i) => `${swatchFor(c)} ${i * step}% ${(i + 1) * step}%`);
  return { background: `linear-gradient(90deg, ${stops.join(", ")})` };
}
