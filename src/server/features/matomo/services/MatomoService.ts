import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  MatomoConnectionRepository,
  type MatomoConnection,
} from "@/server/features/matomo/repositories/MatomoConnectionRepository";
import { AppError } from "@/server/lib/errors";
import {
  listMatomoSites,
  normalizeMatomoBaseUrl,
  type MatomoSite,
} from "@/server/lib/matomoClient";
import { MatomoReportError } from "@/server/lib/matomoErrors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { MIN_BETTER_AUTH_SECRET_LENGTH } from "@/shared/selfhost-checks";

async function readSecret(): Promise<string | null> {
  const secret = (await getOptionalEnvValue("BETTER_AUTH_SECRET"))?.trim();
  return secret && secret.length >= MIN_BETTER_AUTH_SECRET_LENGTH
    ? secret
    : null;
}

async function getEncryptionKey(): Promise<string> {
  const secret = await readSecret();
  if (!secret) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      `Set BETTER_AUTH_SECRET to at least ${MIN_BETTER_AUTH_SECRET_LENGTH} characters to connect Matomo. It encrypts the stored API token.`,
    );
  }
  return secret;
}

async function isConfigured(): Promise<boolean> {
  return (await readSecret()) !== null;
}

function getConnection(projectId: string): Promise<MatomoConnection | null> {
  return MatomoConnectionRepository.getByProjectId(projectId);
}

/** Sites the token can view, for the picker. The token is not stored here. */
async function listSites(input: {
  baseUrl: string;
  token: string;
}): Promise<{ baseUrl: string; sites: MatomoSite[] }> {
  const baseUrl = await normalizeMatomoBaseUrl(input.baseUrl);
  const sites = await listMatomoSites({ baseUrl, token: input.token });
  return { baseUrl, sites };
}

async function connect(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  baseUrl: string;
  token: string;
  siteId: string;
}): Promise<MatomoConnection> {
  const key = await getEncryptionKey();
  const { baseUrl, sites } = await listSites(input);
  const site = sites.find((candidate) => candidate.idsite === input.siteId);
  if (!site) {
    throw new MatomoReportError(
      "matomo_site_inaccessible",
      `The Matomo token has no view access to site ${input.siteId}.`,
    );
  }
  return MatomoConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    baseUrl,
    siteId: site.idsite,
    siteName: site.name,
    siteMainUrl: site.main_url,
    siteTimeZone: site.timezone,
    siteCurrencyCode: site.currency,
    tokenCiphertext: await symmetricEncrypt({ key, data: input.token }),
    connectedByUserId: input.userId,
  });
}

/** The saved connection plus its token, decrypted in memory only. */
async function getCredentials(
  projectId: string,
): Promise<{ connection: MatomoConnection; token: string }> {
  const connection = await getConnection(projectId);
  if (!connection) {
    throw new MatomoReportError(
      "matomo_not_connected",
      "Matomo is not connected for this project.",
    );
  }
  const key = await getEncryptionKey();
  try {
    const token = await symmetricDecrypt({
      key,
      data: connection.tokenCiphertext,
    });
    return { connection, token };
  } catch {
    // A rotated BETTER_AUTH_SECRET makes the stored token unreadable.
    throw new MatomoReportError(
      "matomo_reconnect_required",
      "The saved Matomo token can no longer be read. Reconnect Matomo.",
    );
  }
}

async function disconnect(projectId: string): Promise<void> {
  await MatomoConnectionRepository.deleteByProjectId(projectId);
}

export const MatomoService = {
  isConfigured,
  getConnection,
  listSites,
  connect,
  getCredentials,
  disconnect,
};
