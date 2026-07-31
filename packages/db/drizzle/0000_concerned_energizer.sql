CREATE SCHEMA "cycle_count";
--> statement-breakpoint
CREATE TYPE "cycle_count"."count_mode" AS ENUM('blind', 'recount');--> statement-breakpoint
CREATE TYPE "cycle_count"."import_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "cycle_count"."import_type" AS ENUM('products', 'barcodes', 'uom', 'prices', 'expected');--> statement-breakpoint
CREATE TYPE "cycle_count"."session_status" AS ENUM('draft', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "cycle_count"."user_role" AS ENUM('admin', 'counter');--> statement-breakpoint
CREATE TABLE "cycle_count"."barcode_units" (
	"barcode" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name" text,
	"uom" text NOT NULL,
	"factor_to_base" numeric(14, 4) NOT NULL,
	"price" numeric(14, 4),
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."barcodes" (
	"barcode" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"line_key" text NOT NULL,
	"sku" text,
	"uom" text NOT NULL,
	"factor_to_base" numeric(14, 4) DEFAULT '1' NOT NULL,
	"scanned_barcode" text,
	"counted_qty" numeric(14, 4) NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"counted_by" uuid NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."count_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"mode" "cycle_count"."count_mode" DEFAULT 'blind' NOT NULL,
	"status" "cycle_count"."session_status" DEFAULT 'draft' NOT NULL,
	"price_list_id" uuid,
	"snapshot_at" timestamp with time zone,
	"expected_source" text,
	"source_branch" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."expected_stock" (
	"session_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"expected_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "expected_stock_session_id_sku_uom_pk" PRIMARY KEY("session_id","sku","uom")
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "cycle_count"."import_type" NOT NULL,
	"session_id" uuid,
	"filename" text NOT NULL,
	"storage_path" text,
	"status" "cycle_count"."import_status" DEFAULT 'pending' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"customer_group" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_list_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"effective_from" date DEFAULT now() NOT NULL,
	"effective_to" date
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."products" (
	"sku" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_uom" text DEFAULT 'PCS' NOT NULL,
	"category" text,
	"location" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"employee_code" text NOT NULL,
	"warehouse" text,
	"role" "cycle_count"."user_role" DEFAULT 'counter' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_count"."uom_conversions" (
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"factor_to_base" numeric(14, 4) NOT NULL,
	CONSTRAINT "uom_conversions_sku_uom_pk" PRIMARY KEY("sku","uom")
);
--> statement-breakpoint
ALTER TABLE "cycle_count"."barcodes" ADD CONSTRAINT "barcodes_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "cycle_count"."products"("sku") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."count_lines" ADD CONSTRAINT "count_lines_session_id_count_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "cycle_count"."count_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."count_lines" ADD CONSTRAINT "count_lines_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "cycle_count"."products"("sku") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."count_sessions" ADD CONSTRAINT "count_sessions_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "cycle_count"."price_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."expected_stock" ADD CONSTRAINT "expected_stock_session_id_count_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "cycle_count"."count_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."expected_stock" ADD CONSTRAINT "expected_stock_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "cycle_count"."products"("sku") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."import_batches" ADD CONSTRAINT "import_batches_session_id_count_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "cycle_count"."count_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."prices" ADD CONSTRAINT "prices_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "cycle_count"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."prices" ADD CONSTRAINT "prices_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "cycle_count"."products"("sku") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count"."uom_conversions" ADD CONSTRAINT "uom_conversions_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "cycle_count"."products"("sku") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "barcode_units_sku_idx" ON "cycle_count"."barcode_units" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "barcodes_sku_idx" ON "cycle_count"."barcodes" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "count_lines_session_idx" ON "cycle_count"."count_lines" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "count_lines_session_sku_idx" ON "cycle_count"."count_lines" USING btree ("session_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "count_lines_upsert_idx" ON "cycle_count"."count_lines" USING btree ("session_id","line_key","counted_by");--> statement-breakpoint
CREATE UNIQUE INDEX "count_sessions_code_idx" ON "cycle_count"."count_sessions" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_name_idx" ON "cycle_count"."price_lists" USING btree ("name");--> statement-breakpoint
CREATE INDEX "prices_lookup_idx" ON "cycle_count"."prices" USING btree ("price_list_id","sku","uom");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_unique_idx" ON "cycle_count"."prices" USING btree ("price_list_id","sku","uom","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_employee_code_idx" ON "cycle_count"."profiles" USING btree ("employee_code");