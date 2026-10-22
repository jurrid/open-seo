import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// Selected Matomo site per project. Matomo authenticates with a plain API
// token, so it is stored here encrypted with BETTER_AUTH_SECRET.
export const matomoConnections = sqliteTable(
  "matomo_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Normalized Matomo root URL with a trailing slash, e.g. "https://stats.example.com/".
    baseUrl: text("base_url").notNull(),
    siteId: text("site_id").notNull(),
    siteName: text("site_name").notNull(),
    siteMainUrl: text("site_main_url").notNull(),
    siteTimeZone: text("site_time_zone").notNull(),
    siteCurrencyCode: text("site_currency_code").notNull(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("matomo_connections_project_idx").on(table.projectId),
    index("matomo_connections_organization_idx").on(table.organizationId),
  ],
);
