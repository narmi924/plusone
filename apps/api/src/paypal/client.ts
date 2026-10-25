import type { OAuthToken } from "@paypal/paypal-server-sdk";
import {
  ApiError,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  VaultController,
} from "@paypal/paypal-server-sdk";
import type { Env } from "../env.js";

// One long-lived SDK client per process. The generated defaults are no request
// timeout and no retries, so both are set here. POST is safe to retry because
// every POST we make carries a PayPal-Request-Id, which PayPal de-duplicates.

export function createPayPal(env: Env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return null;

  const client = new Client({
    environment: env.PAYPAL_ENV === "live" ? Environment.Production : Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: env.PAYPAL_CLIENT_ID,
      oAuthClientSecret: env.PAYPAL_CLIENT_SECRET,
    },
    timeout: 20_000,
    httpClientOptions: {
      timeout: 20_000,
      retryConfig: {
        maxNumberOfRetries: 2,
        retryInterval: 1,
        backoffFactor: 2,
        maximumRetryWaitTime: 10,
        retryOnTimeout: true,
        httpStatusCodesToRetry: [408, 429, 500, 502, 503, 504],
        httpMethodsToRetry: ["GET", "PUT", "POST"],
      },
    },
  });

  const baseUrl =
    env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  let token: OAuthToken | undefined;

  /** Bearer token for REST endpoints the SDK doesn't cover (webhooks). Cached until it expires. */
  async function accessToken() {
    token = await client.clientCredentialsAuthManager.updateToken(token);
    return token.accessToken;
  }

  /** Plain REST call with the SDK's token, for APIs the SDK doesn't cover (webhooks, invoicing). */
  async function rest<T>(
    method: string,
    path: string,
    body?: string | object,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`PayPal ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    orders: new OrdersController(client),
    payments: new PaymentsController(client),
    vault: new VaultController(client),
    rest,
  };
}

export type PayPal = NonNullable<ReturnType<typeof createPayPal>>;

/**
 * Readable summary of a PayPal error. Typed errors carry the parsed payload in
 * `result` (with PayPal's own snake_case field names); a bare ApiError, and a typed
 * one whose body wasn't parsed, only has the raw `body`, so parse that ourselves.
 */
export function describePayPalError(err: unknown): {
  status: number;
  issue: string | null;
  message: string;
} {
  if (err instanceof ApiError) {
    const result = (err.result ?? parseBody(err.body)) as
      | {
          name?: string;
          message?: string;
          debug_id?: string;
          details?: Array<{ issue?: string; description?: string }>;
        }
      | undefined;
    const issue = result?.details?.[0]?.issue ?? null;
    const message =
      result?.details?.[0]?.description ??
      result?.message ??
      (typeof err.body === "string" ? err.body.slice(0, 300) : "PayPal request failed");
    return {
      status: err.statusCode,
      issue,
      message: result?.debug_id ? `${message} (debug ${result.debug_id})` : message,
    };
  }
  return { status: 500, issue: null, message: err instanceof Error ? err.message : String(err) };
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
