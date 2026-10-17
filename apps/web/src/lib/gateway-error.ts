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
