import type { OrderDTO, StockChange } from "@plusone/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { buyers, liveSessions, sellers } from "../db/schema.js";
import type { Pushes } from "../realtime.js";
import { describeVariant } from "./catalog.js";
import { ASSISTANT_NAME, insertMessage, toMessageDTO } from "./chat.js";
import { getOrderDTO } from "./orders.js";
import type { WaitlistOffer } from "./waitlist.js";

// Messages the server sends on its own, not in reply to a chat line: a hold that
// ran out, a waitlisted item that freed up, a refund. Written per language so
// they arrive instantly and say exactly what happened; the buyer's language is
// whatever PlusOne last heard them use.

type Template =
  | "holdEnded"
  | "freedForYou"
  | "refunded"
  | "limitReached"
  | "payReminder"
  | "shipped"
  | "invoiced"
  | "invoicedLink"
  | "invoiceReminder"
  | "autopaid"
  | "autopayStopped";

const TEMPLATES: Record<string, Record<Template, string>> = {
  en: {
    holdEnded:
      "Your hold on {item} ran out, so it's back on sale. Say +1 again if you still want it.",
    freedForYou:
      "Good news: {item} freed up and it's yours now, held for {min} min. Pay from your parcel.",
    refunded: "{item} is cancelled and {amount} is on its way back to your PayPal.",
    limitReached: "Sorry, it's {max} per person for {item}, and you already have yours.",
    payReminder:
      "Friendly reminder: {item} is still held for you for {min} more min. Tap Pay on your parcel to keep it.",
    shipped: "Your order is on its way with {carrier}. Tracking number: {tracking}.",
    invoiced:
      "The live has ended. Your {item} stays held for you until {due}. We've emailed you a PayPal invoice, or pay from your parcel.",
    invoicedLink:
      "The live has ended. Your {item} stays held for you until {due}. Pay the PayPal invoice from your parcel.",
    invoiceReminder:
      "Friendly reminder: your PayPal invoice for {item} is open until {due}. Pay it from your parcel to keep it.",
    autopaid:
      "Paid {amount} with your saved PayPal (auto-pay is on). {left} left of tonight's limit. Changed your mind? Just say so.",
    autopayStopped:
      "Auto-pay didn't pay for this one: {reason}. Tap Pay on your parcel to keep it.",
  },
  ms: {
    holdEnded:
      "Masa simpan untuk {item} dah tamat, jadi ia dijual semula. Taip +1 lagi kalau masih nak.",
    freedForYou:
      "Berita baik: {item} dah ada dan sekarang milik anda, disimpan {min} minit. Bayar di bungkusan anda.",
    refunded: "{item} dibatalkan dan {amount} sedang dipulangkan ke PayPal anda.",
    limitReached: "Maaf, {item} dihadkan {max} seorang, dan anda dah ada.",
    payReminder:
      "Peringatan mesra: {item} masih disimpan untuk anda {min} minit lagi. Tekan Pay pada bungkusan anda untuk simpan.",
    shipped: "Pesanan anda sudah dihantar melalui {carrier}. Nombor penjejakan: {tracking}.",
    invoiced:
      "Live sudah tamat. {item} masih disimpan untuk anda sehingga {due}. Invois PayPal telah dihantar ke e-mel anda, atau bayar di bungkusan anda.",
    invoicedLink:
      "Live sudah tamat. {item} masih disimpan untuk anda sehingga {due}. Bayar invois PayPal di bungkusan anda.",
    invoiceReminder:
      "Peringatan mesra: invois PayPal untuk {item} dibuka sehingga {due}. Bayar di bungkusan anda untuk simpan.",
    autopaid:
      "Dibayar {amount} dengan PayPal tersimpan anda (bayar automatik). Baki had malam ini: {left}. Ubah fikiran? Beritahu saja.",
    autopayStopped:
      "Bayar automatik tak bayar yang ini: {reason}. Tekan Pay pada bungkusan anda untuk simpan.",
  },
  zh: {
    holdEnded: "{item} 的保留时间到了，已重新开卖。还想要的话再发一次 +1。",
    freedForYou: "好消息：{item} 空出来了，现在归你，保留 {min} 分钟。在你的包裹单上付款就行。",
    refunded: "{item} 已取消，{amount} 正退回你的 PayPal。",
    limitReached: "不好意思，{item} 每人限 {max} 件，你已经拿到了。",
    payReminder: "温馨提醒：{item} 还为你保留 {min} 分钟，在包裹单上点 Pay 就能留住。",
    shipped: "你的订单已经通过 {carrier} 寄出，单号：{tracking}。",
    invoiced:
      "直播结束了。{item} 继续为你保留到 {due}。PayPal 账单已发到你的邮箱，也可以在包裹单上直接付款。",
    invoicedLink: "直播结束了。{item} 继续为你保留到 {due}。在包裹单上打开 PayPal 账单付款即可。",
    invoiceReminder: "温馨提醒：{item} 的 PayPal 账单在 {due} 前有效，在包裹单上付款就能留住。",
    autopaid: "已用你保存的 PayPal 自动付款 {amount}。今晚额度还剩 {left}。想改主意直接说。",
    autopayStopped: "这次没有自动付款：{reason}。在包裹单上点 Pay 就能留住。",
  },
  th: {
    holdEnded: "เวลาจอง {item} หมดแล้ว สินค้ากลับมาขายใหม่ ถ้ายังต้องการพิมพ์ +1 อีกครั้งนะคะ",
    freedForYou: "ข่าวดี: {item} ว่างแล้วและเป็นของคุณ จองไว้ {min} นาที ชำระเงินได้ที่พัสดุของคุณค่ะ",
    refunded: "ยกเลิก {item} แล้ว กำลังคืนเงิน {amount} เข้า PayPal ของคุณค่ะ",
    limitReached: "ขออภัย {item} จำกัดคนละ {max} ชิ้น และคุณได้ไปแล้วค่ะ",
    payReminder: "แจ้งเตือน: {item} ยังจองไว้ให้คุณอีก {min} นาที กด Pay ที่พัสดุของคุณเพื่อเก็บไว้นะคะ",
    shipped: "ส่งของให้แล้วผ่าน {carrier} เลขพัสดุ: {tracking}",
    invoiced:
      "ไลฟ์จบแล้ว {item} ยังจองไว้ให้คุณถึง {due} เราส่งใบแจ้งหนี้ PayPal ไปที่อีเมลแล้ว หรือชำระที่พัสดุของคุณได้เลยค่ะ",
    invoicedLink: "ไลฟ์จบแล้ว {item} ยังจองไว้ให้คุณถึง {due} ชำระใบแจ้งหนี้ PayPal ได้ที่พัสดุของคุณค่ะ",
    invoiceReminder:
      "แจ้งเตือน: ใบแจ้งหนี้ PayPal สำหรับ {item} ชำระได้ถึง {due} ชำระที่พัสดุของคุณเพื่อเก็บไว้นะคะ",
    autopaid:
      "ชำระ {amount} ด้วย PayPal ที่บันทึกไว้แล้ว (จ่ายอัตโนมัติ) วงเงินคืนนี้เหลือ {left} เปลี่ยนใจบอกได้เลยค่ะ",
    autopayStopped: "จ่ายอัตโนมัติไม่ได้ชำระรายการนี้: {reason} กด Pay ที่พัสดุของคุณเพื่อเก็บไว้นะคะ",
  },
  id: {
    holdEnded:
      "Waktu simpan untuk {item} sudah habis, jadi dijual lagi. Ketik +1 lagi kalau masih mau.",
    freedForYou:
      "Kabar baik: {item} tersedia dan sekarang milikmu, disimpan {min} menit. Bayar di paketmu.",
    refunded: "{item} dibatalkan dan {amount} sedang dikembalikan ke PayPal-mu.",
    limitReached: "Maaf, {item} dibatasi {max} per orang, dan kamu sudah dapat.",
    payReminder:
      "Pengingat: {item} masih disimpan untukmu {min} menit lagi. Ketuk Pay di paketmu supaya tidak hilang.",
    shipped: "Pesananmu sudah dikirim lewat {carrier}. Nomor resi: {tracking}.",
    invoiced:
      "Live sudah selesai. {item} tetap disimpan untukmu sampai {due}. Tagihan PayPal sudah dikirim ke emailmu, atau bayar di paketmu.",
    invoicedLink:
      "Live sudah selesai. {item} tetap disimpan untukmu sampai {due}. Bayar tagihan PayPal dari paketmu.",
    invoiceReminder:
      "Pengingat: tagihan PayPal untuk {item} terbuka sampai {due}. Bayar dari paketmu supaya tidak hilang.",
    autopaid:
      "Sudah dibayar {amount} dengan PayPal tersimpanmu (bayar otomatis). Sisa limit malam ini: {left}. Berubah pikiran? Bilang saja.",
    autopayStopped:
      "Bayar otomatis tidak membayar yang ini: {reason}. Ketuk Pay di paketmu supaya tidak hilang.",
  },
};

export function phrase(locale: string | null, template: Template, vars: Record<string, string>) {
  const lang = (locale ?? "en").toLowerCase().split("-")[0] ?? "en";
  const text = (TEMPLATES[lang] ?? TEMPLATES.en)?.[template] ?? "";
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

export function createNotifier(deps: {
  db: Db;
  realtime: Pushes;
  /** Sees every order update on its way out (e.g. to schedule a payment reminder). */
  onOrder?: (order: OrderDTO) => void;
}) {
  const { db, realtime } = deps;

  async function buyerInfo(buyerId: string) {
    const [b] = await db
      .select({ name: buyers.name, locale: buyers.locale })
      .from(buyers)
      .where(eq(buyers.id, buyerId));
    return b ?? { name: "Someone", locale: null };
  }

  const self = {
    /** Only this buyer (and the seller) sees it. */
    async privateTo(
      sessionId: string,
      buyerId: string,
      body: string,
      replyToId: string | null = null,
    ) {
      if (!body.trim()) return;
      const row = await insertMessage(db, {
        sessionId,
        authorKind: "assistant",
        authorName: ASSISTANT_NAME,
        buyerId,
        visibility: "private",
        body,
        replyToId,
      });
      realtime.message(toMessageDTO(row));
    },
    /** A line everyone in the room sees, the way a host calls out who got what. */
    async announce(sessionId: string, body: string) {
      const row = await insertMessage(db, {
        sessionId,
        authorKind: "system",
        authorName: ASSISTANT_NAME,
        visibility: "public",
        body,
      });
      realtime.message(toMessageDTO(row));
    },
    async orders(orderIds: Iterable<string>) {
      for (const id of new Set(orderIds)) {
        const dto = await getOrderDTO(db, id);
        if (!dto) continue;
        realtime.order(dto);
        deps.onOrder?.(dto);
      }
    },
    stock(sessionId: string, changes: StockChange[]) {
      realtime.stock(sessionId, changes);
    },
    attentionChanged(sessionId: string) {
      realtime.attentionChanged(sessionId);
    },
    waitlistChanged(sessionId: string) {
      realtime.waitlistChanged(sessionId);
    },
    /** A hold ran out: tell the buyer it's gone back on sale. */
    async holdEnded(sessionId: string, buyerId: string, variantId: string) {
      const [b, item] = await Promise.all([buyerInfo(buyerId), describeVariant(db, variantId)]);
      await self.privateTo(sessionId, buyerId, phrase(b.locale, "holdEnded", { item }));
    },
    /** Freed stock went to people on the waitlist: tell each of them, and the room. */
    async waitlistOffers(sessionId: string, offers: WaitlistOffer[]) {
      if (offers.length === 0) return;
      realtime.waitlistChanged(sessionId);
      const [s] = await db
        .select({ holdMinutes: sellers.holdMinutes })
        .from(liveSessions)
        .innerJoin(sellers, eq(sellers.id, liveSessions.sellerId))
        .where(eq(liveSessions.id, sessionId));
      for (const offer of offers) {
        const [b, item] = await Promise.all([
          buyerInfo(offer.buyerId),
          describeVariant(db, offer.variantId),
        ]);
        await self.privateTo(
          sessionId,
          offer.buyerId,
          phrase(b.locale, "freedForYou", { item, min: String(s?.holdMinutes ?? 15) }),
        );
        await self.announce(sessionId, `${b.name} got ${item} from the waitlist`);
      }
      await self.orders(offers.map((o) => o.orderId));
      self.stock(
        sessionId,
        offers.map((o) => o.stock),
      );
    },
  };
  return self;
}

export type Notifier = ReturnType<typeof createNotifier>;
