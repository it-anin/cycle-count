CREATE TABLE "cycle_count"."catalog_state" (
	"key" text PRIMARY KEY NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cycle_count"."count_sessions" ADD COLUMN "catalog_version" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
INSERT INTO "cycle_count"."catalog_state" ("key")
VALUES ('master')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "cycle_count"."catalog_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "catalog_state_read" ON "cycle_count"."catalog_state"
  FOR SELECT TO authenticated USING (cycle_count.cc_is_active_user());
--> statement-breakpoint
CREATE POLICY "catalog_state_write" ON "cycle_count"."catalog_state"
  FOR ALL TO authenticated USING (cycle_count.cc_is_admin()) WITH CHECK (cycle_count.cc_is_admin());
