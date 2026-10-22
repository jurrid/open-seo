import { SkeletonTableRows } from "@/client/components/SkeletonPresets";
import { CardShell } from "@/client/components/CardShell";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { moreDetailsClass } from "@/client/features/dashboard/cardParts";
import { MetricsTable, percentChange } from "@/client/components/MetricsTable";
import {
  formatCount,
  formatCtr,
} from "@/client/features/search-performance/SearchPerformanceColumns";
import { getMatomoDashboardReport } from "@/serverFunctions/matomo";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/client/components/ui/chart";

const visitsChartConfig = {
  visits: { label: "Visits", color: "var(--color-primary)" },
} satisfies ChartConfig;

function formatTrendDay(date: string): string {
  // Local-time construction, see Ga4Card.
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function statValue(
  value: number | null,
  format: (value: number) => string,
): string {
  return value === null ? "—" : format(value);
}

function changeNode(current: number | null, previous: number | null) {
  const change = percentChange(current, previous);
  if (change === null) return undefined;
  return (
    <span
      className={
        change > 0
          ? "text-success"
          : change < 0
            ? "text-destructive"
            : "text-muted-foreground"
      }
    >
      {change > 0 ? "+" : ""}
      {change}%
    </span>
  );
}

/** Organic (search engine) visits from the project's Matomo site. */
export function MatomoCard({ projectId }: { projectId: string }) {
  const reportQuery = useQuery({
    queryKey: ["dashboardMatomoReport", projectId],
    queryFn: () => getMatomoDashboardReport({ data: { projectId } }),
  });
  const report = reportQuery.data;

  return (
    <CardShell
      title="Organic traffic"
      action={
        <Link
          to="/p/$projectId/settings/integrations"
          params={{ projectId }}
          hash="matomo"
          className={moreDetailsClass}
        >
          Manage
        </Link>
      }
    >
      <p className="mb-4 text-sm text-muted-foreground">
        Matomo{report?.connected ? ` · ${report.siteName}` : ""} · Last 28 days
      </p>
      {reportQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn&rsquo;t load Matomo data. Try again shortly.
        </p>
      ) : !report ? (
        <div className="space-y-3" aria-busy>
          <SkeletonTableRows rows={5} columns={3} />
          <Skeleton className="h-24" />
        </div>
      ) : !report.connected ? (
        <p className="text-sm text-muted-foreground">
          {report.problem === "matomo_not_connected"
            ? "Matomo is no longer connected."
            : "Matomo rejected the saved token or site."}{" "}
          <Link
            to="/p/$projectId/settings/integrations"
            params={{ projectId }}
            hash="matomo"
            className="underline"
          >
            Reconnect Matomo
          </Link>
        </p>
      ) : report.totals.visits === 0 ? (
        <p className="text-sm text-muted-foreground">
          No organic search visits recorded in the last 28 days yet.
        </p>
      ) : (
        <div className="space-y-4">
          <MetricsTable
            showChange
            rows={[
              {
                label: "Visits",
                value: formatCount(report.totals.visits),
                change: changeNode(
                  report.totals.visits,
                  report.prevTotals.visits,
                ),
              },
              {
                label: "Converted visits",
                value: formatCount(report.totals.convertedVisits),
                change: changeNode(
                  report.totals.convertedVisits,
                  report.prevTotals.convertedVisits,
                ),
              },
              {
                label: "Conversion rate",
                value: statValue(report.totals.conversionRate, formatCtr),
              },
              {
                label: "Bounce rate",
                value: statValue(report.totals.bounceRate, formatCtr),
              },
              {
                label: "Avg. visit duration",
                value: statValue(
                  report.totals.avgVisitDurationSeconds,
                  formatDuration,
                ),
              },
            ]}
          />
          <ChartContainer config={visitsChartConfig} className="h-24">
            <AreaChart
              data={report.trend}
              margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            >
              <XAxis dataKey="date" hide />
              <YAxis hide domain={[0, "auto"]} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(label: unknown) =>
                      typeof label === "string" ? formatTrendDay(label) : ""
                    }
                    valueFormatter={(value) => formatCount(Number(value))}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="visits"
                stroke="var(--color-visits)"
                strokeWidth={2}
                fill="var(--color-visits)"
                fillOpacity={0.08}
              />
            </AreaChart>
          </ChartContainer>
        </div>
      )}
    </CardShell>
  );
}
