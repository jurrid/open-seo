import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { MatomoReportingService } from "@/server/features/matomo/services/MatomoReportingService";
import { MatomoService } from "@/server/features/matomo/services/MatomoService";
import { AppError } from "@/server/lib/errors";
import { MatomoReportError } from "@/server/lib/matomoErrors";
import { requireProjectContext } from "@/serverFunctions/middleware";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const credentialsSchema = projectScopedSchema.extend({
  baseUrl: z.string().trim().min(1).max(2_000),
  token: z.string().trim().min(1).max(200),
});
const connectSchema = credentialsSchema.extend({
  siteId: z.string().regex(/^\d+$/),
});

type MatomoFailure = {
  ok: false;
  field: "baseUrl" | "token";
  message: string;
};

/** Errors the person fixing the form can act on come back as copy, not codes. */
function toFailure(error: unknown): MatomoFailure {
  if (error instanceof MatomoReportError) {
    const tokenProblem =
      error.code === "matomo_reconnect_required" ||
      error.code === "matomo_site_inaccessible";
    return {
      ok: false,
      field: tokenProblem ? "token" : "baseUrl",
      message: error.message,
    };
  }
  if (error instanceof AppError && error.code === "CRAWL_TARGET_BLOCKED") {
    return {
      ok: false,
      field: "baseUrl",
      message:
        "That URL points at a private or internal address. Use the public URL of your Matomo installation.",
    };
  }
  if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
    return {
      ok: false,
      field: "baseUrl",
      message: "Enter a valid Matomo URL.",
    };
  }
  if (error instanceof AppError && error.code === "AUTH_CONFIG_MISSING") {
    return { ok: false, field: "token", message: error.message };
  }
  throw error;
}

export const getMatomoConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [connection, configured] = await Promise.all([
      MatomoService.getConnection(context.projectId),
      MatomoService.isConfigured(),
    ]);
    return {
      connected: Boolean(connection),
      canManage: hasOrgPermission(context.role, { integration: ["manage"] }),
      configured,
      baseUrl: connection?.baseUrl ?? null,
      siteId: connection?.siteId ?? null,
      siteName: connection?.siteName ?? null,
      siteMainUrl: connection?.siteMainUrl ?? null,
      connectedAt: connection?.createdAt ?? null,
    };
  });

export const listMatomoSites = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(credentialsSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    try {
      const { baseUrl, sites } = await MatomoService.listSites(data);
      return {
        ok: true as const,
        baseUrl,
        sites: sites.map((site) => ({
          siteId: site.idsite,
          name: site.name,
          mainUrl: site.main_url,
        })),
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export const connectMatomo = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(connectSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    try {
      const connection = await MatomoService.connect({
        projectId: context.projectId,
        organizationId: context.organizationId,
        userId: context.userId,
        baseUrl: data.baseUrl,
        token: data.token,
        siteId: data.siteId,
      });
      return { ok: true as const, siteName: connection.siteName };
    } catch (error) {
      return toFailure(error);
    }
  });

export const disconnectMatomo = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await MatomoService.disconnect(context.projectId);
    return { connected: false as const };
  });

/** The dashboard's Matomo card: organic totals vs the previous period plus a
 *  daily visits trend over the last 28 complete days. */
export const getMatomoDashboardReport = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    try {
      const overview = await MatomoReportingService.getOrganicOverview({
        projectId: context.projectId,
      });
      return {
        connected: true as const,
        siteName: overview.source.siteName,
        totals: overview.current,
        prevTotals: overview.previous,
        trend: overview.trend,
      };
    } catch (error) {
      // Not connected or a dead token: show the connect state instead of
      // retrying a report that can never succeed.
      if (
        error instanceof MatomoReportError &&
        (error.code === "matomo_not_connected" ||
          error.code === "matomo_reconnect_required" ||
          error.code === "matomo_site_inaccessible")
      ) {
        return { connected: false as const, problem: error.code };
      }
      throw error;
    }
  });
