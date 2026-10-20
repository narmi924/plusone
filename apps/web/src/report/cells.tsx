import type { CustomCellRendererProps } from "ag-grid-react";
import type { CSSProperties } from "react";

// Grid cells written the way the order book is: held items highlighted, paid
// ones stamped, refunds in red pen, cancellations struck through.

const STRUCK: CSSProperties = {
  color: "#8b97bd",
  textDecoration: "line-through",
  textDecorationColor: "#e4002b",
};

const STATUS: Record<string, { label: string; style: CSSProperties }> = {
  held: {
    label: "Held",
    style: {
      background: "linear-gradient(transparent 22%, #ffe500 22%, #ffe500 86%, transparent 86%)",
      padding: "0 4px",
      fontWeight: 700,
    },
  },
  paid: {
    label: "PAID",
    style: {
      border: "2px solid #13883e",
      color: "#13883e",
      borderRadius: 3,
      padding: "1px 5px",
      fontSize: 11,
      fontWeight: 800,
      letterSpacing: "0.04em",
      display: "inline-block",
      transform: "rotate(-4deg)",
    },
  },
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
  if (!value) return <span style={{ color: "#6b6b66" }}>not paid</span>;
  const id = String(value);
  return (
    <a
      href={`https://www.sandbox.paypal.com/activity/payment/${id}`}
      target="_blank"
      rel="noreferrer"
      title={`PayPal capture ${id}`}
      style={{ color: "#2140a8", fontVariantNumeric: "tabular-nums" }}
    >
      {id}
    </a>
  );
}
