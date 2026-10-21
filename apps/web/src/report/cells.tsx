import type { CustomCellRendererProps } from "ag-grid-react";
import type { CSSProperties } from "react";

// Grid cells in the labels' language: held in yellow, paid as a black strip,
// refunds in red, cancellations struck through.

const STRUCK: CSSProperties = {
  color: "#6a6258",
  textDecoration: "line-through",
};

const PILL: CSSProperties = {
  borderRadius: 999,
  padding: "2px 9px",
  fontSize: 12,
  fontWeight: 800,
  display: "inline-block",
  lineHeight: 1.4,
};

const STATUS: Record<string, { label: string; style: CSSProperties }> = {
  held: { label: "Held", style: { ...PILL, background: "#fff3a8", border: "1.5px solid #000" } },
  paid: { label: "PAID", style: { ...PILL, background: "#000", color: "#fff" } },
  refunded: { label: "Refunded", style: { color: "#e4002b", fontWeight: 700 } },
  cancelled: { label: "Cancelled", style: STRUCK },
  released: { label: "Hold ended", style: STRUCK },
};

export function StatusCell({ value, node }: CustomCellRendererProps) {
  // Also called for the grand-total row.
  if (value == null || node?.footer) return null;
  const s = STATUS[String(value)];
  if (!s) return <span>{String(value)}</span>;
  return <span style={s.style}>{s.label}</span>;
}

export function MoneyCell({ value, valueFormatted }: CustomCellRendererProps) {
  return (
    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
      {valueFormatted ?? String(value ?? "")}
    </span>
  );
}

export function CaptureCell({ value, node }: CustomCellRendererProps) {
  if (node?.footer) return null;
  if (!value) return <span style={{ color: "#6a6258" }}>not paid</span>;
  const id = String(value);
  return (
    <a
      href={`https://www.sandbox.paypal.com/activity/payment/${id}`}
      target="_blank"
      rel="noreferrer"
      title={`PayPal capture ${id}`}
      style={{ color: "#000", fontVariantNumeric: "tabular-nums", textDecoration: "underline" }}
    >
      {id}
    </a>
  );
}
