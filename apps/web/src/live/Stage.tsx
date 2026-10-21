import { formatMoney, type ProductDTO } from "@plusone/shared";
import type { ReactNode } from "react";
import type { Claim } from "../lib/claims";
import { swatchFor } from "../lib/swatch";

// The live room: the host's video fills a black stage and the price hangs on
// it as a shelf label. Every "+1" that lands pops a small tag up the side.
// Chat and the input bar float over the bottom.

export function priceLabel(cents: number, currency: string) {
  return formatMoney(cents, currency).replace(".00", "");
}

export function Stage({
  product,
  currency,
  deals,
  claims,
  video,
  header,
  ended = false,
  children,
}: {
  product: ProductDTO | null;
  currency: string;
  deals: string[];
  /** Recent "+1 Aisha, Blue M" moments, newest first. */
  claims: Claim[];
  /** The host's camera; without it the stage shows the product in type. */
  video: ReactNode;
  header: ReactNode;
  /** The live is over. */
  ended?: boolean;
  /** Chat and the input bar, laid over the bottom of the stage. */
  children: ReactNode;
}) {
  return (
    <section className="relative isolate h-full min-h-[560px] overflow-hidden bg-stage text-white">
      {video ? (
        <div className="absolute inset-0 -z-10">{video}</div>
      ) : (
        <CameraOff product={product} ended={ended} />
      )}
      {/* keeps text readable over any picture */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_top,rgb(0_0_0/0.8)_0%,rgb(0_0_0/0.3)_40%,transparent_62%),linear-gradient(to_bottom,rgb(0_0_0/0.55)_0%,transparent_20%)]" />

      <div className="absolute inset-x-0 top-0 p-4 sm:p-6">{header}</div>

      {product && (
        <div className="absolute top-20 right-4 flex flex-col items-end gap-3 sm:top-24 sm:right-10">
          <PriceTag product={product} currency={currency} />
          {deals.map((d) => (
            <div
              key={d}
              className="max-w-56 rounded-[10px] border-2 border-dashed border-black bg-label px-2.5 py-1.5 text-right text-[13px] leading-tight font-bold text-black"
            >
              {d}
            </div>
          ))}
          {claims.length > 0 && (
            <ol className="mt-1 flex flex-col items-end gap-1.5" aria-label="Just ordered">
              {claims.slice(0, 3).map((c, i) => (
                <li
                  key={c.id}
                  className="animate-[rise_300ms_ease-out] rounded-full bg-label px-3 py-1.5 text-[13px] font-bold text-black shadow-[0_4px_12px_rgb(0_0_0/0.25)]"
                  style={{ opacity: 1 - i * 0.22 }}
                >
                  <span className="mr-1 text-pen">+1</span>
                  {c.who}, {c.what}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 p-4 sm:p-6">{children}</div>
    </section>
  );
}

/** The price as a shelf label: product on a black band, the number big, stock below. */
function PriceTag({ product, currency }: { product: ProductDTO; currency: string }) {
  const left = product.variants.reduce((n, v) => n + v.available, 0);
  const colors = [
    ...new Set(product.variants.map((v) => v.color).filter((c): c is string => Boolean(c))),
  ];
  const price = priceLabel(product.priceCents, currency);
  return (
    <div
      className="w-40 -rotate-2 overflow-hidden rounded-[10px] border-2 border-black bg-label text-black shadow-[0_14px_30px_rgb(0_0_0/0.3)] sm:w-52"
      role="img"
      aria-label={`${product.name}, ${price}, ${left} left`}
    >
      <div className="flex justify-between gap-2 bg-black px-2.5 py-1.5 text-[11px] font-bold text-white sm:text-[13px]">
        <span>{product.code}</span>
        <span className="truncate">{product.name}</span>
      </div>
      <div className="sort px-3 pt-2 pb-1 text-[56px] sm:text-[84px]">
        <span className="align-top text-[0.45em]">{price.replace(/[\d.,]/g, "")}</span>
        {price.replace(/[^\d.,]/g, "")}
      </div>
      <div className="border-t-[1.5px] border-black bg-sticker px-3 py-1.5 text-[11px] font-bold sm:text-[13px]">
        {left > 0 ? `${left} left${colors.length ? ` in ${colors.join(", ")}` : ""}` : "Sold out"}
      </div>
    </div>
  );
}

/** No camera right now: the product carries the stage on its own. */
function CameraOff({ product, ended }: { product: ProductDTO | null; ended: boolean }) {
  if (!product) {
    return (
      <div className="absolute inset-0 -z-10 flex items-center justify-center p-10 text-center text-white/60">
        The host is getting ready. Stay in the chat.
      </div>
    );
  }
  const colors = [
    ...new Set(product.variants.map((v) => v.color).filter((c): c is string => Boolean(c))),
  ];
  return (
    <div className="absolute inset-x-0 top-0 -z-10 px-4 pt-24 pr-48 sm:px-12 sm:pt-32 sm:pr-80">
      <p className="text-sm text-white/60">
        {ended
          ? "The live has ended. Last on screen:"
          : "Camera's off for a moment. On screen now:"}
      </p>
      <h2 className="mt-2 max-w-[12ch] text-4xl leading-[0.92] font-black [font-stretch:85%] sm:text-6xl">
        {product.name}
      </h2>
      {colors.length > 0 && (
        <div className="mt-6 flex gap-3" aria-hidden="true">
          {colors.map((c) => (
            <span
              key={c}
              className="h-10 w-10 rounded-[10px] ring-2 ring-white/30"
              style={{ background: swatchFor(c) }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
