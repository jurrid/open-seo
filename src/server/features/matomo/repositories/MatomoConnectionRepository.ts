import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { matomoConnections } from "@/db/schema";

export type MatomoConnection = typeof matomoConnections.$inferSelect;

async function getByProjectId(
  projectId: string,
): Promise<MatomoConnection | null> {
  const rows = await db
    .select()
    .from(matomoConnections)
    .where(eq(matomoConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  baseUrl: string;
  siteId: string;
  siteName: string;
  siteMainUrl: string;
  siteTimeZone: string;
  siteCurrencyCode: string;
  tokenCiphertext: string;
  connectedByUserId: string;
}): Promise<MatomoConnection> {
  const { projectId, ...changes } = input;
  const [row] = await db
    .insert(matomoConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: matomoConnections.projectId,
      set: { ...changes, updatedAt: sql`(current_timestamp)` },
    })
    .returning();
  if (!row) throw new Error(`Failed to upsert matomo_connection ${projectId}`);
  return row;
}

async function deleteByProjectId(projectId: string): Promise<void> {
  await db
    .delete(matomoConnections)
    .where(eq(matomoConnections.projectId, projectId));
}

export const MatomoConnectionRepository = {
  getByProjectId,
  upsert,
  deleteByProjectId,
};
