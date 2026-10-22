import {
  ga4DateInTimeZone,
  inclusiveGa4Days,
  shiftGa4Date,
} from "@/server/features/ga4/services/Ga4Dates";
import { MatomoService } from "@/server/features/matomo/services/MatomoService";
import { AppError } from "@/server/lib/errors";
import {
  getMatomoDailyVisitsSummary,
  getMatomoEntryPages,
  getMatomoGoalNames,
  getMatomoVisitsSummary,
  MATOMO_ORGANIC_SEGMENT,
  type MatomoVisitsSummary,
} from "@/server/lib/matomoClient";
import type { MatomoConnection } from "@/server/features/matomo/repositories/MatomoConnectionRepository";

const DEFAULT_RANGE_DAYS = 28;

type DateRange = { startDate: string; endDate: string };

type MatomoOrganicMetrics = {
  visits: number;
  actions: number;
  convertedVisits: number;
  conversionRate: number | null;
  bounceRate: number | null;
  avgVisitDurationSeconds: number | null;
  actionsPerVisit: number | null;
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function toMetrics(summary: MatomoVisitsSummary): MatomoOrganicMetrics {
  return {
    visits: summary.nb_visits,
    actions: summary.nb_actions,
    convertedVisits: summary.nb_visits_converted,
    conversionRate: ratio(summary.nb_visits_converted, summary.nb_visits),
    bounceRate: ratio(summary.bounce_count, summary.nb_visits),
    avgVisitDurationSeconds: ratio(summary.sum_visit_length, summary.nb_visits),
    actionsPerVisit: ratio(summary.nb_actions, summary.nb_visits),
  };
}

function percentChange(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

// Matomo also allows offsets like "UTC+2", which Intl cannot read.
function siteToday(timeZone: string): string {
  try {
    return ga4DateInTimeZone(new Date(), timeZone);
  } catch {
    return ga4DateInTimeZone(new Date(), "UTC");
  }
}

/** Defaults to the last 28 complete days in the site's time zone. */
function resolveRange(
  connection: MatomoConnection,
  input: { startDate?: string; endDate?: string },
): DateRange {
  if (Boolean(input.startDate) !== Boolean(input.endDate)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Provide both startDate and endDate, or neither.",
    );
  }
  if (input.startDate && input.endDate) {
    if (input.startDate > input.endDate) {
      throw new AppError(
        "VALIDATION_ERROR",
        "startDate must be on or before endDate.",
      );
    }
    return { startDate: input.startDate, endDate: input.endDate };
  }
  const endDate = shiftGa4Date(siteToday(connection.siteTimeZone), -1);
  return {
    startDate: shiftGa4Date(endDate, -(DEFAULT_RANGE_DAYS - 1)),
    endDate,
  };
}

function previousRange(range: DateRange): DateRange {
  const days = inclusiveGa4Days(range.startDate, range.endDate);
  return {
    startDate: shiftGa4Date(range.startDate, -days),
    endDate: shiftGa4Date(range.startDate, -1),
  };
}

function sourceOf(connection: MatomoConnection) {
  return {
    provider: "matomo" as const,
    baseUrl: connection.baseUrl,
    siteId: connection.siteId,
    siteName: connection.siteName,
    siteMainUrl: connection.siteMainUrl,
    siteTimeZone: connection.siteTimeZone,
  };
}

/** Organic (search engine) visits vs the previous period, plus a daily trend. */
async function getOrganicOverview(input: {
  projectId: string;
  startDate?: string;
  endDate?: string;
}) {
  const { connection, token } = await MatomoService.getCredentials(
    input.projectId,
  );
  const range = resolveRange(connection, input);
  const previous = previousRange(range);
  const base = {
    baseUrl: connection.baseUrl,
    token,
    siteId: connection.siteId,
    segment: MATOMO_ORGANIC_SEGMENT,
  };
  const [currentSummary, previousSummary, daily] = await Promise.all([
    getMatomoVisitsSummary({ ...base, ...range }),
    getMatomoVisitsSummary({ ...base, ...previous }),
    getMatomoDailyVisitsSummary({ ...base, ...range }),
  ]);

  const current = toMetrics(currentSummary);
  const prior = toMetrics(previousSummary);
  const trend: Array<{ date: string; visits: number }> = [];
  for (
    let date = range.startDate;
    date <= range.endDate;
    date = shiftGa4Date(date, 1)
  ) {
    trend.push({ date, visits: daily[date]?.nb_visits ?? 0 });
  }

  return {
    status: "ok" as const,
    source: sourceOf(connection),
    request: {
      dateRange: range,
      previousDateRange: previous,
      segment: MATOMO_ORGANIC_SEGMENT,
    },
    current,
    previous: prior,
    comparison: {
      visits: percentChange(current.visits, prior.visits),
      convertedVisits: percentChange(
        current.convertedVisits,
        prior.convertedVisits,
      ),
      conversionRate: percentChange(
        current.conversionRate,
        prior.conversionRate,
      ),
      bounceRate: percentChange(current.bounceRate, prior.bounceRate),
      avgVisitDurationSeconds: percentChange(
        current.avgVisitDurationSeconds,
        prior.avgVisitDurationSeconds,
      ),
    },
    trend,
  };
}

function groupedLabel(label: string): string {
  if (label === "Others") return "(other pages, grouped by Matomo)";
  const folder = /^(.*) - Others$/.exec(label)?.[1];
  return folder ? `(other pages under ${folder}, grouped by Matomo)` : label;
}

/** Pages where organic visits started, busiest first. */
async function getOrganicLandingPages(input: {
  projectId: string;
  startDate?: string;
  endDate?: string;
  limit: number;
  offset: number;
}) {
  const { connection, token } = await MatomoService.getCredentials(
    input.projectId,
  );
  const range = resolveRange(connection, input);
  const site = {
    baseUrl: connection.baseUrl,
    token,
    siteId: connection.siteId,
  };
  const [pages, goalNames] = await Promise.all([
    getMatomoEntryPages({
      ...site,
      segment: MATOMO_ORGANIC_SEGMENT,
      ...range,
      limit: input.limit,
      offset: input.offset,
    }),
    getMatomoGoalNames(site),
  ]);
  const rows = pages.map((page) => {
    // Conversions in visits that started on this page, across all goals.
    const conversions = Object.values(page.goals).reduce(
      (sum, count) => sum + count,
      0,
    );
    return {
      page: page.url ?? groupedLabel(page.label),
      // Matomo folds rows past its report row limit into "Others" summary rows.
      grouped: !page.url && /(^| - )Others$/.test(page.label),
      visits: page.entry_nb_visits,
      conversions,
      conversionRate: ratio(conversions, page.entry_nb_visits),
      goalConversions: Object.fromEntries(
        Object.entries(page.goals).map(([goalId, count]) => [
          goalNames.get(goalId) ?? `Goal ${goalId}`,
          count,
        ]),
      ),
      bounceRate: ratio(page.entry_bounce_count, page.entry_nb_visits),
      avgVisitDurationSeconds: ratio(
        page.entry_sum_visit_length,
        page.entry_nb_visits,
      ),
      actionsPerVisit: ratio(page.entry_nb_actions, page.entry_nb_visits),
    };
  });

  return {
    status: "ok" as const,
    source: sourceOf(connection),
    request: {
      dateRange: range,
      segment: MATOMO_ORGANIC_SEGMENT,
      limit: input.limit,
      offset: input.offset,
      conversionAttribution: "entry",
    },
    goals: [...goalNames.values()],
    rowCount: rows.length,
    rows,
  };
}

export const MatomoReportingService = {
  getOrganicOverview,
  getOrganicLandingPages,
};
