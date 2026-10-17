export class LocalGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The Gateway's machine-readable refusal, such as `chat_busy` or `file_changed`. */
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "LocalGatewayError";
  }
}

const DETAIL_MAX = 200;

/**
 * The owner-facing sentence for a Gateway refusal. The Gateway's own `error` names the cause in
 * its terms (`hello.md: EACCES`); a refusal the owner can act on gets a sentence that says what to do.
 */
export function ownerMessage(code: string | undefined, detail: string | undefined, fallback: string): string {
  const shown = detail?.trim() && detail.length <= DETAIL_MAX ? detail.trim() : undefined;
  const because = (lead: string): string => (shown ? `${lead}: ${shown}.` : `${lead}.`);
  switch (code) {
    case "daemon_stopping":
      return "The harness is stopping. Send again once it restarts.";
    case "too_large":
      return because("That is too large for the harness");
    case "filesystem_error":
      return because("The harness could not read or write that on disk");
    case "invalid_path":
      return because("That file path cannot be used");
    default:
      return shown ?? fallback;
  }
}
