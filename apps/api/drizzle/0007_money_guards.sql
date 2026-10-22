ALTER TABLE "order_lines" ADD COLUMN "from_waitlist" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "autopay_waiting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;