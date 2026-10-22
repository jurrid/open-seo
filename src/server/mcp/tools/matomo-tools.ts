import type { CallToolResult } from "@modelcontextprotocol/server";
import { sort } from "remeda";
import { z } from "zod";
import { MatomoReportingService } from "@/server/features/matomo/services/MatomoReportingService";
import { MatomoReportError } from "@/server/lib/matomoErrors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable, percentCell, truncatedCell } from "@/server/mcp/table";
import { buildDashboardUrl } from "@/server/mcp/urls";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Inclusive YYYY-MM-DD date. Provide both startDate and endDate.");

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
};

const SOURCE_NOTE =
  "Reads only the Matomo site already connected to an OpenSEO project the caller is authorized to access, using the token saved on that connection. Organic means Matomo's referrerType==search segment. Read-only and uses no OpenSEO credits.";

// One loose object for both branches: the MCP SDK cannot publish a union.
const envelopeSchema = z
  .object({
    status: z.enum(["ok", "error"]),
    source: looseObjectOutputSchema.optional(),
    request: looseObjectOutputSchema.optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        actionUrl: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type ProjectContext = { baseUrl: string };

function errorResponse(
  projectId: string,
  context: ProjectContext,
  error: unknown,
): CallToolResult {
  if (!(error instanceof MatomoReportError)) throw error;
  const actionUrl = [
    "matomo_not_connected",
    "matomo_reconnect_required",
    "matomo_site_inaccessible",
  ].includes(error.code)
    ? buildDashboardUrl(
        context.baseUrl,
        `/p/${projectId}/settings/integrations#matomo`,
      )
    : undefined;
  return mcpResponse({
    text: `${error.message}${actionUrl ? ` Continue here: ${actionUrl}` : ""}`,
    meta: buildProjectMeta(context, projectId),
    structuredContent: {
      status: "error",
      error: { code: error.code, message: error.message, actionUrl },
    },
  });
}

const overviewInputSchema = z.strictObject({
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});
type OverviewArgs = z.infer<typeof overviewInputSchema>;

export const getMatomoOrganicOverviewTool = {
  name: "get_matomo_organic_overview",
  config: {
    title: "Get Matomo organic overview",
    description: `Answer whether organic search traffic is improving using Matomo: visits, converted visits, conversion rate, bounce rate and average visit duration, an equal-length previous-period comparison, and a daily visits trend. Defaults to the last 28 complete days in the site's time zone. ${SOURCE_NOTE}`,
    inputSchema: overviewInputSchema,
    outputSchema: envelopeSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  handler: withMcpProjectAuth(async (args: OverviewArgs, context) => {
    try {
      const result = await MatomoReportingService.getOrganicOverview(args);
      const { dateRange, previousDateRange } = result.request;
      const metrics = [
        "visits",
        "convertedVisits",
        "conversionRate",
        "bounceRate",
        "avgVisitDurationSeconds",
        "actionsPerVisit",
      ] as const;
      const table = formatMcpTable(
        metrics.map((metric) => ({
          metric,
          current: result.current[metric],
          previous: result.previous[metric],
        })),
        [
          { header: "metric", value: (row) => row.metric },
          { header: "current", value: (row) => row.current },
          { header: "previous", value: (row) => row.previous },
        ],
      );
      const busiest = sort(result.trend, (a, b) => b.visits - a.visits)
        .slice(0, 3)
        .map((day) => `${day.date} (${day.visits})`)
        .join(", ");
      return mcpResponse({
        text: `Matomo organic overview for ${result.source.siteName}, ${dateRange.startDate} through ${dateRange.endDate}, compared with ${previousDateRange.startDate} through ${previousDateRange.endDate}.\n${table}\nBusiest days: ${busiest || "none"}.`,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: result,
      });
    } catch (error) {
      return errorResponse(args.projectId, context, error);
    }
  }),
};

const landingPagesInputSchema = z.strictObject({
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  limit: z.number().int().min(1).max(1_000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
});
type LandingPagesArgs = z.infer<typeof landingPagesInputSchema>;

export const getMatomoOrganicLandingPagesTool = {
  name: "get_matomo_organic_landing_pages",
  config: {
    title: "Get Matomo organic landing pages",
    description: `List the pages where organic search visits started, busiest first, with entry visits, bounce rate, average visit duration and actions per visit. Use it to see which pages earn search traffic and which ones lose visitors immediately. ${SOURCE_NOTE}`,
    inputSchema: landingPagesInputSchema,
    outputSchema: envelopeSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  },
  handler: withMcpProjectAuth(async (args: LandingPagesArgs, context) => {
    try {
      const result = await MatomoReportingService.getOrganicLandingPages(args);
      const { dateRange } = result.request;
      const table = formatMcpTable(result.rows, [
        { header: "page", value: (row) => row.page, format: truncatedCell(90) },
        { header: "visits", value: (row) => row.visits },
        {
          header: "bounce rate",
          value: (row) => row.bounceRate,
          format: percentCell,
        },
        {
          header: "avg. seconds",
          value: (row) =>
            row.avgVisitDurationSeconds === null
              ? null
              : Math.round(row.avgVisitDurationSeconds),
        },
      ]);
      return mcpResponse({
        text: `Matomo organic landing pages for ${result.source.siteName}, ${dateRange.startDate} through ${dateRange.endDate} (${result.rowCount} rows from offset ${args.offset}).\n${table}`,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: result,
      });
    } catch (error) {
      return errorResponse(args.projectId, context, error);
    }
  }),
};
