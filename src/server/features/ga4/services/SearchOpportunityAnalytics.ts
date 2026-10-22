import { Ga4ReportingService } from "@/server/features/ga4/services/Ga4ReportingService";
import { MatomoReportingService } from "@/server/features/matomo/services/MatomoReportingService";

// Organic landing-page outcomes per normalized page, from whichever analytics
// connection scores search opportunities.

export type Ga4PageMetrics = {
  sessions: number;
  activeUsers: number;
  engagedSessions: number;
  engagementRate: number;
  keyEvents: number;
  sessionKeyEventRate: number;
  transactions: number;
  purchaseRevenue: number | null;
};

export type MatomoPageMetrics = {
  visits: number;
  conversions: number;
  conversionRate: number | null;
  goalConversions: Record<string, number>;
  bounceRate: number | null;
  nonBounceRate: number | null;
  avgVisitDurationSeconds: number | null;
  actionsPerVisit: number | null;
};

export function normalizePageKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "(not set)") return null;
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    let host = url.hostname.toLowerCase();
    const defaultPort =
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443");
    if (url.port && !defaultPort) host += `:${url.port}`;
    let path = url.pathname || "/";
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return null;
  }
}

function numberField(
  row: Record<string, string | number | null>,
  name: string,
): number {
  const value = row[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type AnalyticsPages =
  | {
      provider: "ga4";
      byPage: Map<string, Ga4PageMetrics>;
      unusableRows: number;
      rowsConsidered: number;
      truncated: boolean;
      source: { propertyId: string; propertyDisplayName: string };
      warnings: string[];
      reportMetadata: Record<string, unknown> & { hasLimitedData: boolean };
      quota: unknown;
    }
  | {
      provider: "matomo";
      byPage: Map<string, MatomoPageMetrics>;
      unusableRows: number;
      rowsConsidered: number;
      truncated: boolean;
      source: { siteId: string; siteName: string };
      warnings: string[];
      reportMetadata: Record<string, unknown> & { hasLimitedData: boolean };
      quota: null;
    };

const ANALYTICS_ROW_LIMIT = 1_000;

export async function loadGa4Pages(
  projectId: string,
  dates: { startDate: string; endDate: string },
): Promise<AnalyticsPages> {
  const ga4 = await Ga4ReportingService.runReport({
    projectId,
    kind: "landing_pages",
    startDate: dates.startDate,
    endDate: dates.endDate,
    limit: ANALYTICS_ROW_LIMIT,
    offset: 0,
    channel: "organic_search",
  });
  const byPage = new Map<string, Ga4PageMetrics>();
  let unusableRows = 0;
  for (const row of ga4.rows) {
    const host = typeof row.hostName === "string" ? row.hostName : "";
    const landing = typeof row.landingPage === "string" ? row.landingPage : "";
    const key = normalizePageKey(`${host}${landing}`);
    if (!key) {
      unusableRows += 1;
      continue;
    }
    byPage.set(key, {
      sessions: numberField(row, "sessions"),
      activeUsers: numberField(row, "activeUsers"),
      engagedSessions: numberField(row, "engagedSessions"),
      engagementRate: numberField(row, "engagementRate"),
      keyEvents: numberField(row, "keyEvents"),
      sessionKeyEventRate: numberField(row, "sessionKeyEventRate"),
      transactions: numberField(row, "transactions"),
      purchaseRevenue:
        typeof row.purchaseRevenue === "number" ? row.purchaseRevenue : null,
    });
  }
  return {
    provider: "ga4",
    byPage,
    unusableRows,
    rowsConsidered: ga4.rows.length,
    truncated: ga4.totalRowCount > ga4.rows.length,
    source: {
      propertyId: ga4.source.propertyId,
      propertyDisplayName: ga4.source.propertyDisplayName,
    },
    warnings: ga4.warnings,
    reportMetadata: ga4.reportMetadata,
    quota: ga4.quota,
  };
}

export async function loadMatomoPages(
  projectId: string,
  dates: { startDate: string; endDate: string },
): Promise<AnalyticsPages> {
  const matomo = await MatomoReportingService.getOrganicLandingPages({
    projectId,
    startDate: dates.startDate,
    endDate: dates.endDate,
    limit: ANALYTICS_ROW_LIMIT,
    offset: 0,
  });
  const byPage = new Map<string, MatomoPageMetrics>();
  let unusableRows = 0;
  let groupedRows = 0;
  for (const row of matomo.rows) {
    // "Others" rows sum pages Matomo folded past its report row limit.
    if (row.grouped) {
      groupedRows += 1;
      continue;
    }
    const key = normalizePageKey(row.page);
    if (!key) {
      unusableRows += 1;
      continue;
    }
    byPage.set(key, {
      visits: row.visits,
      conversions: row.conversions,
      conversionRate: row.conversionRate,
      goalConversions: row.goalConversions,
      bounceRate: row.bounceRate,
      nonBounceRate: row.bounceRate === null ? null : 1 - row.bounceRate,
      avgVisitDurationSeconds: row.avgVisitDurationSeconds,
      actionsPerVisit: row.actionsPerVisit,
    });
  }
  return {
    provider: "matomo",
    byPage,
    unusableRows: unusableRows + groupedRows,
    rowsConsidered: matomo.rows.length,
    truncated: matomo.rows.length >= ANALYTICS_ROW_LIMIT,
    source: {
      siteId: matomo.source.siteId,
      siteName: matomo.source.siteName,
    },
    warnings: groupedRows > 0 ? ["matomo_grouped_rows"] : [],
    // Matomo has no sampling, but grouped rows hide some pages from the join.
    reportMetadata: { hasLimitedData: groupedRows > 0, groupedRows },
    quota: null,
  };
}
