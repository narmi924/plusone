import type {
  AttentionDTO,
  BuyerDTO,
  ChatMessageDTO,
  LookDTO,
  OrderDTO,
  PublicConfig,
  RecapDTO,
  RuleDTO,
  SessionDTO,
  WaitingDTO,
  WalletDTO,
} from "@plusone/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue: string | null = null,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    buyerToken?: string | null;
    sellerToken?: string | null;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.buyerToken) headers.authorization = `Bearer ${opts.buyerToken}`;
  if (opts.sellerToken) headers["x-seller-token"] = opts.sellerToken;
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const data = (await res.json().catch(() => null)) as { error?: string; issue?: string } | null;
  if (!res.ok)
    throw new ApiError(
      data?.error ?? `Request failed (${res.status})`,
      res.status,
      data?.issue ?? null,
    );
  return data as T;
}

export const api = {
  config: () => request<PublicConfig>("/api/config"),
  live: (handle: string) => request<SessionDTO>(`/api/live/${encodeURIComponent(handle)}`),
  messages: (
    sessionId: string,
    auth: { buyerToken?: string | null; sellerToken?: string | null },
  ) => request<ChatMessageDTO[]>(`/api/sessions/${sessionId}/messages`, auth),
  join: (name: string, email: string) =>
    request<{ token: string; buyer: BuyerDTO }>("/api/buyers", { body: { name, email } }),
  me: (buyerToken: string) => request<BuyerDTO>("/api/me", { buyerToken }),
  myOrders: (sessionId: string, buyerToken: string) =>
    request<OrderDTO[]>(`/api/sessions/${sessionId}/my-orders`, { buyerToken }),
  startPayPal: (orderId: string, buyerToken: string, save = false) =>
    request<{ paypalOrderId: string }>(`/api/orders/${orderId}/paypal`, {
      method: "POST",
      body: { save },
      buyerToken,
    }),
  paySaved: (orderId: string, buyerToken: string) =>
    request<OrderDTO>(`/api/orders/${orderId}/pay-saved`, { body: {}, buyerToken }),
  wallet: (sessionId: string, buyerToken: string) =>
    request<WalletDTO>(`/api/sessions/${sessionId}/wallet`, { buyerToken }),
  setAutopay: (sessionId: string, limitCents: number | null, buyerToken: string) =>
    request<WalletDTO>(`/api/sessions/${sessionId}/autopay`, {
      method: "PUT",
      body: { limitCents },
      buyerToken,
    }),
  forgetPayPal: (buyerToken: string) =>
    request<WalletDTO>("/api/me/paypal", { method: "DELETE", buyerToken }),
  capturePayPal: (paypalOrderId: string, buyerToken: string) =>
    request<OrderDTO>(`/api/paypal/orders/${paypalOrderId}/capture`, {
      method: "POST",
      body: {},
      buyerToken,
    }),
  replyAttention: (id: string, text: string, sellerToken: string) =>
    request<{ ok: true }>(`/api/seller/attention/${id}/reply`, { body: { text }, sellerToken }),
  sellerLogin: (password: string) =>
    request<{ token: string }>("/api/seller/login", { body: { password } }),
  sellerOrders: (sessionId: string, sellerToken: string) =>
    request<OrderDTO[]>(`/api/seller/sessions/${sessionId}/orders`, { sellerToken }),
  showcase: (sessionId: string, productId: string, sellerToken: string) =>
    request<{ productId: string }>(`/api/seller/sessions/${sessionId}/showcase`, {
      body: { productId },
      sellerToken,
    }),
  look: (sessionId: string, frame: string, sellerToken: string) =>
    request<LookDTO>(`/api/seller/sessions/${sessionId}/look`, { body: { frame }, sellerToken }),
  videoToken: (sessionId: string, sellerToken?: string | null) =>
    request<{ url: string; token: string; identity: string }>(
      `/api/sessions/${sessionId}/video-token`,
      {
        sellerToken: sellerToken ?? null,
      },
    ),
  setVideo: (sessionId: string, on: boolean, sellerToken: string) =>
    request<{ on: boolean }>(`/api/seller/sessions/${sessionId}/video`, {
      body: { on },
      sellerToken,
    }),
  attention: (sessionId: string, sellerToken: string) =>
    request<AttentionDTO[]>(`/api/seller/sessions/${sessionId}/attention`, { sellerToken }),
  resolveAttention: (id: string, sellerToken: string) =>
    request<{ ok: true }>(`/api/seller/attention/${id}/resolve`, {
      method: "POST",
      body: {},
      sellerToken,
    }),
  refundLine: (lineId: string, sellerToken: string) =>
    request<{ ok: true }>(`/api/seller/lines/${lineId}/refund`, {
      method: "POST",
      body: {},
      sellerToken,
    }),
  hostSpeech: (sessionId: string, text: string, sellerToken: string) =>
    request<{ ok: true }>(`/api/seller/sessions/${sessionId}/host-speech`, {
      body: { text },
      sellerToken,
    }),
  waitlist: (sessionId: string, sellerToken: string) =>
    request<WaitingDTO[]>(`/api/seller/sessions/${sessionId}/waitlist`, { sellerToken }),
  rules: (sessionId: string, sellerToken: string) =>
    request<RuleDTO[]>(`/api/seller/sessions/${sessionId}/rules`, { sellerToken }),
  applyRule: (id: string, sellerToken: string) =>
    request<RuleDTO>(`/api/seller/rules/${id}/apply`, { method: "POST", body: {}, sellerToken }),
  dismissRule: (id: string, sellerToken: string) =>
    request<{ ok: true }>(`/api/seller/rules/${id}/dismiss`, {
      method: "POST",
      body: {},
      sellerToken,
    }),
  shipOrder: (
    orderId: string,
    body: { carrier: string; trackingNumber: string; carrierName?: string },
    sellerToken: string,
  ) => request<{ ok: true }>(`/api/seller/orders/${orderId}/ship`, { body, sellerToken }),
  remind: (sessionId: string, orderNumber: number, sellerToken: string) =>
    request<{ ok: true; buyer: string | null; minutesLeft: number }>(
      `/api/seller/sessions/${sessionId}/orders/${orderNumber}/remind`,
      { method: "POST", body: {}, sellerToken },
    ),
  endLive: (sessionId: string, sellerToken: string) =>
    request<{ owing: number }>(`/api/seller/sessions/${sessionId}/end`, {
      method: "POST",
      body: {},
      sellerToken,
    }),
  recap: (sessionId: string, sellerToken: string) =>
    request<{ recap: RecapDTO | null }>(`/api/seller/sessions/${sessionId}/recap`, {
      sellerToken,
    }),
  applyProposal: (sessionId: string, proposalId: string, sellerToken: string) =>
    request<{ ok: true; result: string }>(
      `/api/seller/sessions/${sessionId}/copilot/${proposalId}/apply`,
      { method: "POST", body: {}, sellerToken },
    ),
  dismissProposal: (sessionId: string, proposalId: string, sellerToken: string) =>
    request<{ ok: true }>(`/api/seller/sessions/${sessionId}/copilot/${proposalId}/dismiss`, {
      method: "POST",
      body: {},
      sellerToken,
    }),
  playCrowd: (sessionId: string, sellerToken: string) =>
    request<{ started: true }>(`/api/seller/sessions/${sessionId}/crowd`, {
      method: "POST",
      body: {},
      sellerToken,
    }),
  resetDemo: (sellerToken: string) =>
    request<{ sessionId: string }>("/api/seller/demo/reset", {
      method: "POST",
      body: {},
      sellerToken,
    }),
};
