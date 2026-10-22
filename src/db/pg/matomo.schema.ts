import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Keep this definition structurally identical to ../matomo.schema.ts.
export const matomoConnections = pgTable(
  "matomo_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    baseUrl: text("base_url").notNull(),
    siteId: text("site_id").notNull(),
    siteName: text("site_name").notNull(),
    siteMainUrl: text("site_main_url").notNull(),
    siteTimeZone: text("site_time_zone").notNull(),
    siteCurrencyCode: text("site_currency_code").notNull(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("matomo_connections_project_idx").on(table.projectId),
    index("matomo_connections_organization_idx").on(table.organizationId),
  ],
);
