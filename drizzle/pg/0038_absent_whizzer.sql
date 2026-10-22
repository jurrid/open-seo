CREATE TABLE "matomo_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"base_url" text NOT NULL,
	"site_id" text NOT NULL,
	"site_name" text NOT NULL,
	"site_main_url" text NOT NULL,
	"site_time_zone" text NOT NULL,
	"site_currency_code" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matomo_connections" ADD CONSTRAINT "matomo_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matomo_connections" ADD CONSTRAINT "matomo_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "matomo_connections_project_idx" ON "matomo_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "matomo_connections_organization_idx" ON "matomo_connections" USING btree ("organization_id");