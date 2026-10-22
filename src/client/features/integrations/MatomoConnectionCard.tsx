import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revalidateLogic } from "@tanstack/react-form";
import { ChartLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CardShell } from "@/client/components/CardShell";
import { PermissionHint } from "@/client/components/PermissionHint";
import { QueryError } from "@/client/components/QueryState";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  connectMatomo,
  disconnectMatomo,
  getMatomoConnection,
  listMatomoSites,
} from "@/serverFunctions/matomo";

const matomoConnectionQueryKey = (projectId: string) => [
  "matomoConnection",
  projectId,
];

const formSchema = z.object({
  baseUrl: z.string().trim().min(1, "Enter your Matomo URL."),
  token: z.string().trim().min(1, "Enter an API token."),
  siteId: z.string(),
});

type MatomoSiteOption = { siteId: string; name: string; mainUrl: string };

/**
 * Connects a Matomo site to the project with a URL and an API token. The
 * first submit loads the sites the token can view; the second saves the pick.
 */
export function MatomoConnectionCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [sites, setSites] = useState<MatomoSiteOption[] | null>(null);

  const connectionQuery = useQuery({
    queryKey: matomoConnectionQueryKey(projectId),
    queryFn: () => getMatomoConnection({ data: { projectId } }),
  });

  const afterChange = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: matomoConnectionQueryKey(projectId),
      }),
      queryClient.invalidateQueries({
        queryKey: ["dashboardActivation", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["dashboardMatomoReport", projectId],
      }),
    ]);
  };

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectMatomo({ data: { projectId } }),
    onSuccess: async () => {
      await afterChange();
      toast.success("Matomo disconnected");
    },
  });

  const form = useAppForm({
    defaultValues: { baseUrl: "", token: "", siteId: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: formSchema },
    onSubmit: async ({ value, formApi }) => {
      const result = sites
        ? await connectMatomo({ data: { projectId, ...value } })
        : await listMatomoSites({
            data: { projectId, baseUrl: value.baseUrl, token: value.token },
          });
      if (!result.ok) {
        formApi.setErrorMap({
          onSubmit: { fields: { [result.field]: result.message } },
        });
        return;
      }
      if ("sites" in result) {
        if (result.sites.length === 0) {
          formApi.setErrorMap({
            onSubmit: {
              fields: { token: "This token can't view any Matomo sites." },
            },
          });
          return;
        }
        setSites(result.sites);
        formApi.setFieldValue("baseUrl", result.baseUrl);
        formApi.setFieldValue("siteId", result.sites[0].siteId);
        return;
      }
      await afterChange();
      toast.success(`Matomo connected to ${result.siteName}`);
      setSites(null);
      setEditing(false);
      formApi.reset();
    },
  });

  const connection = connectionQuery.data;

  if (connectionQuery.isError) {
    return (
      <CardShell title="Matomo" icon={<ChartLine className="size-4" />}>
        <QueryError
          error={connectionQuery.error}
          fallback="Couldn't load the Matomo connection."
          onRetry={() => void connectionQuery.refetch()}
          isRetrying={connectionQuery.isFetching}
        />
      </CardShell>
    );
  }

  const status = !connection ? null : (
    <Badge
      variant={
        connection.connected
          ? "success"
          : connection.configured
            ? "outline"
            : "warning"
      }
    >
      <span className="size-1.5 rounded-full bg-current" />
      {connection.connected
        ? "Connected"
        : connection.configured
          ? "Not connected"
          : "Setup required"}
    </Badge>
  );

  return (
    <CardShell
      title="Matomo"
      icon={<ChartLine className="size-4" />}
      action={status}
    >
      {!connection ? (
        <Skeleton className="h-16" />
      ) : !connection.configured ? (
        <p className="text-sm text-muted-foreground">
          Set <code>BETTER_AUTH_SECRET</code> (at least 32 characters) on this
          OpenSEO install. It encrypts the stored Matomo API token.
        </p>
      ) : connection.connected && !editing ? (
        <div className="space-y-4">
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold">
              {connection.siteName}
            </p>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              {connection.siteMainUrl} · site {connection.siteId} on{" "}
              {connection.baseUrl}
            </p>
          </div>
          {connection.canManage ? (
            <fieldset
              disabled={disconnectMutation.isPending}
              className="flex flex-wrap items-center gap-1"
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
              >
                Change site or token
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
              >
                {disconnectMutation.isPending
                  ? "Disconnecting…"
                  : "Disconnect project"}
              </Button>
            </fieldset>
          ) : null}
        </div>
      ) : !connection.canManage ? (
        <PermissionHint action="connect Matomo" />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            See organic visits, landing pages and conversions from Matomo.
            Create a token in Matomo under Personal &rarr; Security &rarr; Auth
            tokens; a user with view access to the site is enough.
          </p>
          <form.AppForm>
            <form.Form className="space-y-3">
              <form.AppField name="baseUrl">
                {(field) => (
                  <field.TextField
                    label="Matomo URL"
                    placeholder="https://stats.example.com"
                    className="font-mono"
                    disabled={sites !== null}
                    required
                  />
                )}
              </form.AppField>
              <form.AppField name="token">
                {(field) => (
                  <field.TextField
                    label="API token"
                    type="password"
                    autoComplete="off"
                    data-ph-mask
                    className="font-mono"
                    disabled={sites !== null}
                    required
                  />
                )}
              </form.AppField>
              {sites ? (
                <form.AppField name="siteId">
                  {(field) => (
                    <field.SelectField
                      label="Site"
                      items={sites.map((site) => ({
                        value: site.siteId,
                        label: `${site.name} (${site.mainUrl || `site ${site.siteId}`})`,
                      }))}
                    />
                  )}
                </form.AppField>
              ) : null}
              <div className="flex flex-wrap items-center gap-1">
                <form.SubmitButton>
                  {sites ? "Connect site" : "Load sites"}
                </form.SubmitButton>
                {sites || editing ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSites(null);
                      setEditing(false);
                      form.reset();
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form.Form>
          </form.AppForm>
        </div>
      )}
    </CardShell>
  );
}
