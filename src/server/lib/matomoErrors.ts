type MatomoReportErrorCode =
  | "matomo_not_connected"
  | "matomo_reconnect_required"
  | "matomo_site_inaccessible"
  | "matomo_unreachable"
  | "matomo_upstream_error"
  | "matomo_malformed_response";

export class MatomoReportError extends Error {
  constructor(
    public readonly code: MatomoReportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MatomoReportError";
  }
}
