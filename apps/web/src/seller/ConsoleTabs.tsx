import type { ReactNode } from "react";
import { Link } from "react-router";

// The seller console's top bar: the live badge, the shop, and two views of
// tonight: the order book (while selling) and the report (the numbers).

export function ConsoleTabs({
  sellerName,
  current,
  ended = false,
  children,
}: {
  sellerName: string;
  current: "book" | "report";
  /** The live is over (unpaid holds were invoiced). */
  ended?: boolean;
  /** Stats and actions on the right. */
  children?: ReactNode;
}) {
  const tab = (to: string, label: string, active: boolean) => (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`border-b-[3px] px-1 pt-1 pb-1.5 text-sm font-bold ${
        active ? "border-pen text-black" : "border-transparent text-quiet hover:text-black"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <header className="flex h-15 shrink-0 items-center gap-4 border-b border-line px-6">
      <span
        className={`rounded px-2 py-1.5 text-[13px] leading-none font-extrabold text-white [font-stretch:112%] ${ended ? "bg-quiet" : "bg-pen"}`}
      >
        {ended ? "ENDED" : "LIVE"}
      </span>
      <h1 className="text-lg font-extrabold">{sellerName}</h1>
      <nav className="ml-4 flex gap-5 self-end" aria-label="Console">
        {tab("/seller", "Tonight's book", current === "book")}
        {tab("/seller/report", "Report", current === "report")}
      </nav>
      <div className="ml-auto flex items-baseline gap-6 tabular">{children}</div>
    </header>
  );
}
