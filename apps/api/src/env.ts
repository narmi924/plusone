import { z } from "zod";

// Everything the server needs from the environment, validated once at boot.
// Keys that are only needed by later features are optional for now so the
// skeleton runs before every account exists.
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().optional().or(z.literal("")),
  SELLER_PASSWORD: z.string().min(1).default("change-me"),
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional().or(z.literal("")),
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_CLIENT_ID: z.string().optional().or(z.literal("")),
  PAYPAL_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  PAYPAL_WEBHOOK_ID: z.string().optional().or(z.literal("")),
  LIVEKIT_URL: z.string().optional().or(z.literal("")),
  LIVEKIT_API_KEY: z.string().optional().or(z.literal("")),
  LIVEKIT_API_SECRET: z.string().optional().or(z.literal("")),
  DEEPGRAM_API_KEY: z.string().optional().or(z.literal("")),
  /** Public demo: shows the seller password and a PayPal sandbox buyer, resets when idle. */
  DEMO_MODE: z
    .enum(["true", "false", ""])
    .default("")
    .transform((v) => v === "true"),
  DEMO_SANDBOX_BUYER_EMAIL: z.string().optional().or(z.literal("")),
  DEMO_SANDBOX_BUYER_PASSWORD: z.string().optional().or(z.literal("")),
  /** Both set: background tasks run on Render Workflows. Otherwise in-process. */
  RENDER_API_KEY: z.string().optional().or(z.literal("")),
  WORKFLOW_SLUG: z.string().optional().or(z.literal("")),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // On Render the service's own address is given; use it unless set explicitly.
  const result = schema.safeParse({
    ...source,
    PUBLIC_URL: source.PUBLIC_URL || source.RENDER_EXTERNAL_URL,
  });
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}

/** Which integrations have credentials present. Shown on /health so setup gaps are obvious. */
export function integrationStatus(env: Env) {
  return {
    database: Boolean(env.DATABASE_URL),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    paypal: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    paypalWebhook: Boolean(env.PAYPAL_WEBHOOK_ID),
    livekit: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
    deepgram: Boolean(env.DEEPGRAM_API_KEY),
    publicUrl: Boolean(env.PUBLIC_URL),
    renderWorkflows: Boolean(env.RENDER_API_KEY && env.WORKFLOW_SLUG),
  };
}
