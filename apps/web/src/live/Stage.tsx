import { formatMoney, type ProductDTO } from "@plusone/shared";
import type { ReactNode } from "react";

// The live room: the host's video fills a black stage, the price sits on it as
// a yellow promo sticker with red numerals, and every "+1" that lands pops a
// small sticker up the side. Chat and the input bar float over the bottom.

const SWATCH: Record<string, string> = {
  Blue: "#3d6fd6",
  Sage: "#9bb59a",
  White: "#f3f1ea",
  Pink: "#f2a7bd",
  Black: "#1b1b1f",
  Beige: "#d8c3a2",
  Navy: "#23305e",
  Maroon: "#7a2333",
  Cream: "#efe5cf",
  Oat: "#d9cbb0",
  Grey: "#9a9aa3",
  Floral: "#e58fa3",
  Paisley: "#b0653c",
};

export function swatchFor(color: string | null) {
  return (color && SWATCH[color]) ?? "#9aa5c4";
}

export function priceLabel(cents: number, currency: string) {
  return formatMoney(cents, currency).replace(".00", "");
}

export function Stage({
  product,
  currency,
  deals,
  plusOnes,
  video,
  header,
  ended = false,
  children,
}: {
  product: ProductDTO | null;
  currency: string;
  deals: string[];
  /** Recent "+1 Aisha, Blue M" moments, newest first. */
  plusOnes: string[];
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
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_top,rgb(0_0_0/0.8)_0%,rgb(0_0_0/0.35)_40%,transparent_62%),linear-gradient(to_bottom,rgb(0_0_0/0.45)_0%,transparent_16%)]" />

      <div className="absolute inset-x-0 top-0 p-4 sm:p-6">{header}</div>

      {product && (
        <div className="absolute top-20 right-4 flex flex-col items-end gap-3 sm:top-24 sm:right-10">
          <div
            className="-rotate-[5deg] rounded-[10px] bg-sticker px-4 pt-2.5 pb-2 text-center text-pen shadow-[0_2px_0_rgb(0_0_0/0.25),0_14px_30px_rgb(0_0_0/0.35)] sm:px-[18px] sm:pt-3"
            role="img"
            aria-label={`Price ${priceLabel(product.priceCents, currency)}`}
          >
            <div className="text-xs font-bold text-black">Tonight</div>
            <div className="price-type text-[46px] leading-[0.9] sm:text-[64px]">
              {priceLabel(product.priceCents, currency)}
            </div>
            <div className="mt-1 text-[13px] font-extrabold text-black">{product.code}</div>
          </div>
          {plusOnes.length > 0 && (
            <ol className="mt-2 flex flex-col items-end gap-2" aria-label="Just ordered">
              {plusOnes.slice(0, 3).map((p, i) => (
                <li
                  key={p}
                  className="animate-[rise_300ms_ease-out] rounded-md bg-sticker px-2.5 py-1.5 text-sm font-extrabold text-black"
                  style={{ opacity: 1 - i * 0.28, rotate: `${i % 2 ? 1.5 : -2}deg` }}
                >
                  <span className="mr-1.5 text-pen">+1</span>
                  {p}
                </li>
              ))}
            </ol>
          )}
          {deals.map((d) => (
            <div
              key={d}
              className="max-w-56 rotate-[2deg] rounded-md bg-sticker px-2.5 py-1.5 text-right text-[13px] leading-tight font-extrabold text-black shadow-[0_8px_20px_rgb(0_0_0/0.3)]"
            >
              {d}
            </div>
          ))}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 p-4 sm:p-6">{children}</div>
    </section>
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
    <div className="absolute inset-x-0 top-0 -z-10 px-4 pt-24 pr-44 sm:px-12 sm:pt-32 sm:pr-72">
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
              className="h-10 w-10 rounded-full ring-2 ring-white/30"
              style={{ background: swatchFor(c) }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
