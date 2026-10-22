ALTER TABLE "buyers" ADD COLUMN "paypal_vault_id" text;--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "paypal_customer_id" text;--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "paypal_email" text;--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "autopay_session_id" uuid;--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "autopay_limit_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "autopay_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "via" text DEFAULT 'checkout' NOT NULL;