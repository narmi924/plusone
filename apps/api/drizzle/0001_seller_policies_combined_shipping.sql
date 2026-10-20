ALTER TABLE "orders" ADD COLUMN "ships_with_order_id" uuid;--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "policies" text DEFAULT '' NOT NULL;