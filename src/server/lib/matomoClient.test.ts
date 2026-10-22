import { beforeEach, expect, it, vi } from "vitest";
import {
  getMatomoVisitsSummary,
  listMatomoSites,
  normalizeMatomoBaseUrl,
} from "./matomoClient";

const mocks = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));

// The real policy resolves DNS; these tests only need its URL parsing.
vi.mock("@/server/lib/audit/url-policy", () => ({
  normalizeAndValidateStartUrl: async (input: string) =>
    new URL(input.startsWith("http") ? input : `https://${input}`).toString(),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue(Response.json([]));
});

const range = {
  baseUrl: "https://stats.example.com/",
  token: "secret-token",
  siteId: "3",
  startDate: "2026-09-01",
  endDate: "2026-09-28",
};

it("normalizes pasted Matomo URLs to the install root", async () => {
  await expect(
    normalizeMatomoBaseUrl(
      "stats.example.com/matomo/index.php?module=CoreHome",
    ),
  ).resolves.toBe("https://stats.example.com/matomo/");
});

it("sends the token in the POST body, never the URL", async () => {
  await listMatomoSites(range);

  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe("https://stats.example.com/index.php");
  const body = init?.body;
  expect(body instanceof URLSearchParams && body.get("token_auth")).toBe(
    "secret-token",
  );
  expect(init?.redirect).toBe("manual");
});

it("reads an empty period as zero visits", async () => {
  await expect(getMatomoVisitsSummary(range)).resolves.toMatchObject({
    nb_visits: 0,
    bounce_count: 0,
  });
});

it("turns Matomo's HTTP 200 token error into a reconnect error", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({
      result: "error",
      message:
        "Unable to authenticate with the provided token. It is either invalid, expired or is required to be sent as a POST parameter.",
    }),
  );

  await expect(getMatomoVisitsSummary(range)).rejects.toMatchObject({
    code: "matomo_reconnect_required",
  });
});

it("refuses to follow a redirect from the Matomo host", async () => {
  mocks.fetch.mockResolvedValue(
    new Response(null, { status: 302, headers: { location: "/login" } }),
  );

  await expect(listMatomoSites(range)).rejects.toMatchObject({
    code: "matomo_unreachable",
  });
});
