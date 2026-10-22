import type { ReactNode } from "react";
import { Link } from "react-router";

// The seller console's top bar: the live badge, the shop, and two views of
// tonight: the labels (while selling) and the report (the numbers). The chat
// opens beside the labels only when the seller wants to read it.

export function ConsoleTabs({
  sellerName,
  current,
  ended = false,
  chat,
  children,
}: {
  sellerName: string;
  current: "book" | "report";
  /** The live is over (unpaid holds were invoiced). */
  ended?: boolean;
  /** The chat column: open or not, and how many lines came in while it was closed. */
  chat?: { open: boolean; unread: number; onToggle: () => void };
  /** Stats and actions on the right. */
  children?: ReactNode;
}) {
  const tab = (to: string, label: string, active: boolean) => (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center px-1 text-sm font-bold ${
        active
          ? "text-black after:absolute after:inset-x-0 after:bottom-0 after:h-1 after:bg-black"
          : "text-quiet hover:text-black"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <header className="flex h-15 shrink-0 items-center gap-4 border-b-2 border-black bg-label px-6">
      <span
        className={`rounded-[5px] px-2 py-1.5 text-[13px] leading-none font-extrabold text-white [font-stretch:112%] ${ended ? "bg-quiet" : "bg-pen"}`}
      >
        {ended ? "ENDED" : "LIVE"}
      </span>
      <h1 className="text-lg font-extrabold">{sellerName}</h1>
      <nav className="ml-4 flex gap-5 self-stretch" aria-label="Console">
        {tab("/seller", "Tonight", current === "book")}
        {tab("/seller/report", "Report", current === "report")}
        {chat && (
          <button
            type="button"
            onClick={chat.onToggle}
            aria-pressed={chat.open}
            className={`relative flex items-center gap-1.5 px-1 text-sm font-bold ${
              chat.open
                ? "text-black after:absolute after:inset-x-0 after:bottom-0 after:h-1 after:bg-black"
                : "text-quiet hover:text-black"
            }`}
          >
            Chat
            {!chat.open && chat.unread > 0 && (
              <span className="rounded-full bg-black px-1.5 text-[11px] leading-[18px] text-white tabular">
                {chat.unread > 99 ? "99+" : chat.unread}
              </span>
            )}
          </button>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-6 tabular">{children}</div>
    </header>
  );
}
