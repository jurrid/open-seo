import { GscService } from "@/server/features/gsc/services/GscService";
import { GscNotConnectedError } from "@/server/lib/gscErrors";
import { resolveGa4DateRange } from "@/server/features/ga4/services/Ga4ReportingService";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { MatomoConnectionRepository } from "@/server/features/matomo/repositories/MatomoConnectionRepository";
import { MatomoReportError } from "@/server/lib/matomoErrors";
import { ga4DateInTimeZone, shiftGa4Date } from "./Ga4Dates";
import {
  loadGa4Pages,
  loadMatomoPages,
  normalizePageKey,
  type Ga4PageMetrics,
  type MatomoPageMetrics,
} from "./SearchOpportunityAnalytics";

type AnalyticsSource = "auto" | "ga4" | "matomo";

type SearchOpportunityInput = {
  projectId: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  analyticsSource?: AnalyticsSource;
};

type Candidate = {
  page: string;
  normalizedPage: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  joinStatus: "joined" | "gsc_only";
  ga4: Ga4PageMetrics | null;
  matomo: MatomoPageMetrics | null;
  score: number | null;
  scoreComponents: {
    demand: number;
    businessValue: number;
    reachability: number;
  } | null;
};

// Matomo also allows offsets like "UTC+2", which Intl cannot read.
function usableTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions()
      .timeZone;
  } catch {
    return "UTC";
  }
}

/** GA4 when connected, else Matomo, unless the caller names one. */
async function selectAnalytics(projectId: string, requested: AnalyticsSource) {
  const [ga4, matomo] = await Promise.all([
    requested === "matomo"
      ? null
      : Ga4ConnectionRepository.getByProjectId(projectId),
    requested === "ga4"
      ? null
      : MatomoConnectionRepository.getByProjectId(projectId),
  ]);
  if (ga4) {
    return {
      provider: "ga4" as const,
      timeZone: ga4.propertyTimeZone,
    };
  }
  if (matomo) {
    return {
      provider: "matomo" as const,
      timeZone: usableTimeZone(matomo.siteTimeZone),
    };
  }
  if (requested === "matomo") {
    throw new MatomoReportError(
      "matomo_not_connected",
      "Matomo is not connected for this project.",
    );
  }
  throw new Ga4ReportError(
    "ga4_not_connected",
    requested === "ga4"
      ? "Google Analytics is not connected for this project."
      : "Connect Google Analytics or Matomo for this project to score search opportunities.",
  );
}

function resolveCombinedDates(
  input: Pick<SearchOpportunityInput, "startDate" | "endDate">,
  propertyTimeZone: string,
  now: Date,
) {
  if (!input.startDate && !input.endDate) {
    const endDate = shiftGa4Date(ga4DateInTimeZone(now, propertyTimeZone), -3);
    return {
      startDate: shiftGa4Date(endDate, -27),
      endDate,
    };
  }
  return resolveGa4DateRange(input, propertyTimeZone, now).resolvedDateRange;
}

function percentileRanks(values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [1];
  return values.map((value) => {
    const lower = values.filter((candidate) => candidate < value).length;
    return lower / (values.length - 1);
  });
}

function roundComponent(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function getOpportunities(
  input: SearchOpportunityInput,
  opts: { now?: Date } = {},
) {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Ga4ReportError(
      "validation_error",
      "limit must be an integer from 1 to 100.",
    );
  }
  const [analyticsChoice, gscConnection] = await Promise.all([
    selectAnalytics(input.projectId, input.analyticsSource ?? "auto"),
    GscService.getConnection(input.projectId),
  ]);
  if (!gscConnection) throw new GscNotConnectedError(input.projectId);

  const now = opts.now ?? new Date();
  const dates = resolveCombinedDates(input, analyticsChoice.timeZone, now);
  const gsc = await GscService.getPerformance({
    projectId: input.projectId,
    dimensions: ["page"],
    startDate: dates.startDate,
    endDate: dates.endDate,
    rowLimit: 1_000,
    startRow: 0,
    type: "web",
    dataState: "final",
  });
  const analytics =
    analyticsChoice.provider === "ga4"
      ? await loadGa4Pages(input.projectId, dates)
      : await loadMatomoPages(input.projectId, dates);

  const candidates: Candidate[] = gsc.rows
    .filter((row) => row.position >= 4 && row.position <= 20)
    .map((row) => {
      const page = row.keys?.[0] ?? "";
      const normalizedPage = normalizePageKey(page);
      const ga4 =
        analytics.provider === "ga4" && normalizedPage
          ? (analytics.byPage.get(normalizedPage) ?? null)
          : null;
      const matomo =
        analytics.provider === "matomo" && normalizedPage
          ? (analytics.byPage.get(normalizedPage) ?? null)
          : null;
      return {
        page,
        normalizedPage,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        joinStatus: ga4 || matomo ? "joined" : "gsc_only",
        ga4,
        matomo,
        score: null,
        scoreComponents: null,
      } satisfies Candidate;
    });

  const joined = candidates.filter(
    (candidate) => candidate.ga4 !== null || candidate.matomo !== null,
  );
  const engagementFallback =
    analytics.provider === "ga4" &&
    joined.length > 0 &&
    joined.every((candidate) => candidate.ga4?.keyEvents === 0);
  const businessValueMetric =
    analytics.provider === "matomo"
      ? "nonBounceRate"
      : engagementFallback
        ? "engagementRate"
        : "sessionKeyEventRate";
  const demand = percentileRanks(
    joined.map((candidate) => Math.log1p(candidate.impressions)),
  );
  const businessValue = percentileRanks(
    joined.map((candidate) =>
      candidate.matomo
        ? (candidate.matomo.nonBounceRate ?? 0)
        : engagementFallback
          ? (candidate.ga4?.engagementRate ?? 0)
          : (candidate.ga4?.sessionKeyEventRate ?? 0),
    ),
  );
  const reachability = percentileRanks(
    joined.map((candidate) => 20 - candidate.position),
  );
  joined.forEach((candidate, index) => {
    const components = {
      demand: roundComponent(demand[index] ?? 0),
      businessValue: roundComponent(businessValue[index] ?? 0),
      reachability: roundComponent(reachability[index] ?? 0),
    };
    candidate.scoreComponents = components;
    candidate.score = Math.round(
      100 *
        (0.5 * components.demand +
          0.3 * components.businessValue +
          0.2 * components.reachability),
    );
  });
  candidates.sort((a, b) => {
    if (a.score == null && b.score != null) return 1;
    if (a.score != null && b.score == null) return -1;
    return (b.score ?? 0) - (a.score ?? 0) || b.impressions - a.impressions;
  });

  const matchedRows = joined.length;
  const unmatchedGscRows = candidates.length - matchedRows;
  const returned = candidates.slice(0, limit);
  return {
    status: "ok" as const,
    source: {
      searchConsoleSiteUrl: gsc.siteUrl,
      analyticsProvider: analytics.provider,
      googleAnalyticsPropertyId:
        analytics.provider === "ga4" ? analytics.source.propertyId : null,
      googleAnalyticsPropertyDisplayName:
        analytics.provider === "ga4"
          ? analytics.source.propertyDisplayName
          : null,
      matomoSiteId:
        analytics.provider === "matomo" ? analytics.source.siteId : null,
      matomoSiteName:
        analytics.provider === "matomo" ? analytics.source.siteName : null,
    },
    request: {
      dateRange: dates,
      limit,
      searchConsoleTimeZone: "America/Los_Angeles",
      analyticsTimeZone: analyticsChoice.timeZone,
    },
    rowCount: returned.length,
    totalCandidateRows: candidates.length,
    rows: returned,
    scoring: {
      formula:
        "round(100 * (0.5 * demand + 0.3 * businessValue + 0.2 * reachability))",
      businessValueMetric,
      engagementFallback,
      scoreDataLimited: analytics.reportMetadata.hasLimitedData,
    },
    coverage: {
      gscRowsConsidered: gsc.rows.length,
      analyticsRowsConsidered: analytics.rowsConsidered,
      matchedRows,
      unmatchedGscRows,
      unmatchedAnalyticsRows:
        Math.max(analytics.byPage.size - matchedRows, 0) +
        analytics.unusableRows,
    },
    truncated: {
      gsc: gsc.rows.length >= 1_000,
      analytics: analytics.truncated,
      candidates: returned.length < candidates.length,
    },
    warnings:
      analyticsChoice.timeZone === "America/Los_Angeles"
        ? analytics.warnings
        : [...analytics.warnings, "source_time_zones_differ"],
    reportMetadata: analytics.reportMetadata,
    quota: analytics.quota,
  };
}

export const SearchOpportunityService = { getOpportunities };
