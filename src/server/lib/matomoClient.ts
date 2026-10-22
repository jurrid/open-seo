import { z } from "zod";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { MatomoReportError } from "@/server/lib/matomoErrors";

// Matomo archives an uncached segment (like organic) on the first request for
// a range, which can take tens of seconds on a busy site.
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;
export const MATOMO_ORGANIC_SEGMENT = "referrerType==search";

// Matomo serializes most numbers as numbers but some installs (and some
// plugins) send numeric strings, and empty periods come back as [].
const metric = z.coerce.number().catch(0);

const siteSchema = z.object({
  idsite: z.coerce.string(),
  name: z.string(),
  main_url: z.string().default(""),
  timezone: z.string().default("UTC"),
  currency: z.string().default("USD"),
});
export type MatomoSite = z.infer<typeof siteSchema>;

const visitsSummarySchema = z.object({
  nb_visits: metric.default(0),
  nb_actions: metric.default(0),
  nb_visits_converted: metric.default(0),
  bounce_count: metric.default(0),
  sum_visit_length: metric.default(0),
});
export type MatomoVisitsSummary = z.infer<typeof visitsSummarySchema>;

const EMPTY_SUMMARY: MatomoVisitsSummary = {
  nb_visits: 0,
  nb_actions: 0,
  nb_visits_converted: 0,
  bounce_count: 0,
  sum_visit_length: 0,
};

const summaryOrEmpty = z
  .union([visitsSummarySchema, z.array(z.unknown()).length(0)])
  .transform((value) => (Array.isArray(value) ? EMPTY_SUMMARY : value));

// With goal columns requested, each row carries per-goal metrics keyed
// "idgoal=N". nb_conversions_entry counts conversions in visits that started on
// the page; it is omitted when zero.
const entryPageGoalsSchema = z
  .union([
    z.record(z.string(), z.object({ nb_conversions_entry: metric.default(0) })),
    z.array(z.unknown()).length(0),
  ])
  .optional()
  .transform((goals) => {
    const conversionsByGoalId: Record<string, number> = {};
    if (!goals || Array.isArray(goals)) return conversionsByGoalId;
    for (const [key, value] of Object.entries(goals)) {
      const goalId = /^idgoal=(\d+)$/.exec(key)?.[1];
      if (goalId && value.nb_conversions_entry > 0) {
        conversionsByGoalId[goalId] = value.nb_conversions_entry;
      }
    }
    return conversionsByGoalId;
  });

const entryPageSchema = z.object({
  label: z.coerce.string(),
  url: z.string().optional(),
  entry_nb_visits: metric.default(0),
  entry_nb_actions: metric.default(0),
  entry_sum_visit_length: metric.default(0),
  entry_bounce_count: metric.default(0),
  goals: entryPageGoalsSchema,
});
type MatomoEntryPage = z.infer<typeof entryPageSchema>;

const goalSchema = z.object({
  idgoal: z.coerce.string(),
  name: z.string(),
});

const errorResponseSchema = z.object({
  result: z.literal("error"),
  message: z.string(),
});

/**
 * Accepts what people paste ("stats.example.com", ".../index.php?module=…",
 * a sub-folder install) and returns the Matomo root with a trailing slash.
 * Rejects private/internal hosts like every other user-supplied fetch target.
 */
export async function normalizeMatomoBaseUrl(input: string): Promise<string> {
  const validated = new URL(await normalizeAndValidateStartUrl(input));
  validated.search = "";
  validated.pathname = validated.pathname.replace(/index\.php$/, "");
  if (!validated.pathname.endsWith("/")) validated.pathname += "/";
  return validated.toString();
}

function classifyMatomoError(message: string): MatomoReportError {
  const short = message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  if (/token|authenticat/i.test(message)) {
    return new MatomoReportError(
      "matomo_reconnect_required",
      `Matomo rejected the API token: ${short}`,
    );
  }
  if (/access/i.test(message)) {
    return new MatomoReportError(
      "matomo_site_inaccessible",
      `The Matomo token has no view access to this site: ${short}`,
    );
  }
  return new MatomoReportError(
    "matomo_upstream_error",
    `Matomo returned an error: ${short}`,
  );
}

async function callMatomo<T>(input: {
  baseUrl: string;
  token: string;
  method: string;
  params?: Record<string, string>;
  schema: z.ZodType<T>;
}): Promise<T> {
  const baseUrl = await normalizeMatomoBaseUrl(input.baseUrl);
  // token_auth goes in the POST body: Matomo rejects tokens in the query
  // string for "secure only" tokens, and URLs end up in access logs.
  const body = new URLSearchParams({
    module: "API",
    method: input.method,
    format: "JSON",
    ...input.params,
    token_auth: input.token,
  });

  let response: Response;
  try {
    response = await fetch(`${baseUrl}index.php`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.warn(
      `[matomo] ${input.method} request to ${baseUrl} failed:`,
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    throw new MatomoReportError(
      "matomo_unreachable",
      timedOut
        ? `Matomo at ${baseUrl} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. It may still be processing this report; try again shortly.`
        : `Could not reach Matomo at ${baseUrl}.`,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    throw new MatomoReportError(
      "matomo_unreachable",
      `Matomo at ${baseUrl} redirected the API request. Use the final Matomo URL instead.`,
    );
  }
  if (!response.ok) {
    throw new MatomoReportError(
      "matomo_upstream_error",
      `Matomo responded with HTTP ${response.status}.`,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new MatomoReportError(
      "matomo_malformed_response",
      `Matomo at ${baseUrl} did not return JSON. Check that the URL points at your Matomo installation.`,
    );
  }

  const apiError = errorResponseSchema.safeParse(json);
  if (apiError.success) throw classifyMatomoError(apiError.data.message);

  const parsed = input.schema.safeParse(json);
  if (!parsed.success) {
    throw new MatomoReportError(
      "matomo_malformed_response",
      `Matomo returned an unexpected response for ${input.method}.`,
    );
  }
  return parsed.data;
}

type Credentials = { baseUrl: string; token: string };
type SiteRange = Credentials & {
  siteId: string;
  startDate: string;
  endDate: string;
  segment?: string;
};

function rangeParams(input: SiteRange, period: "range" | "day") {
  return {
    idSite: input.siteId,
    period,
    date: `${input.startDate},${input.endDate}`,
    ...(input.segment ? { segment: input.segment } : {}),
  };
}

export function listMatomoSites(input: Credentials): Promise<MatomoSite[]> {
  return callMatomo({
    ...input,
    method: "SitesManager.getSitesWithAtLeastViewAccess",
    schema: z.array(siteSchema),
  });
}

export function getMatomoVisitsSummary(
  input: SiteRange,
): Promise<MatomoVisitsSummary> {
  return callMatomo({
    ...input,
    method: "VisitsSummary.get",
    params: rangeParams(input, "range"),
    schema: summaryOrEmpty,
  });
}

/** One summary per day in the range, keyed by YYYY-MM-DD. */
export function getMatomoDailyVisitsSummary(
  input: SiteRange,
): Promise<Record<string, MatomoVisitsSummary>> {
  return callMatomo({
    ...input,
    method: "VisitsSummary.get",
    params: rangeParams(input, "day"),
    schema: z.record(z.string(), summaryOrEmpty),
  });
}

export function getMatomoEntryPages(
  input: SiteRange & { limit: number; offset: number },
): Promise<MatomoEntryPage[]> {
  return callMatomo({
    ...input,
    method: "Actions.getEntryPageUrls",
    params: {
      ...rangeParams(input, "range"),
      flat: "1",
      filter_limit: String(input.limit),
      filter_offset: String(input.offset),
      filter_sort_column: "entry_nb_visits",
      filter_sort_order: "desc",
      // Adds the per-goal entry conversion columns to each row.
      filter_update_columns_when_show_all_goals: "1",
      idGoal: "0",
    },
    schema: z.array(entryPageSchema),
  });
}

/** Goal id → name for the site; empty when the site has no goals. */
export async function getMatomoGoalNames(
  input: Credentials & { siteId: string },
): Promise<Map<string, string>> {
  const goals = await callMatomo({
    ...input,
    method: "Goals.getGoals",
    params: { idSite: input.siteId },
    schema: z.union([z.array(goalSchema), z.record(z.string(), goalSchema)]),
  });
  const list = Array.isArray(goals) ? goals : Object.values(goals);
  return new Map(list.map((goal) => [goal.idgoal, goal.name]));
}
