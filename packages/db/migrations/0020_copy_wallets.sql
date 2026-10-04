CREATE TABLE "copy_wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"label" text,
	"active" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_signature" text,
	"copied_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "copy_wallets_address_shape" CHECK (char_length("copy_wallets"."address") between 32 and 44),
	CONSTRAINT "copy_wallets_label_length" CHECK ("copy_wallets"."label" is null or char_length("copy_wallets"."label") <= 60),
	CONSTRAINT "copy_wallets_copied_count" CHECK ("copy_wallets"."copied_count" >= 0)
);
