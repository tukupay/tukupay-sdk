/**
 * Errors raised by the library. Every failure the API reports arrives as
 * `{"errors": ...}`; that value is kept untouched on `errors`.
 */
export class TukuPayError extends Error {
  /** HTTP status, or undefined when no response was received. */
  readonly status: number | undefined;
  /** The API's `errors` value: a string, a list of field errors, or an object. */
  readonly errors: unknown;
  /** The whole response body, as parsed. */
  readonly body: unknown;

  constructor(message: string, init: { status?: number; errors?: unknown; body?: unknown; cause?: unknown } = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.errors = init.errors;
    this.body = init.body;
  }
}

/** 401: the API key or the user's token was missing, wrong, revoked or expired. */
export class AuthenticationError extends TukuPayError {}

/** 403: the credentials are valid but not allowed to do this. */
export class PermissionError extends TukuPayError {}

/** 404: not found, or it belongs to another app. The API does not say which. */
export class NotFoundError extends TukuPayError {}

/** 400 or 422: the request was refused as sent. */
export class ValidationError extends TukuPayError {}

/** 429: the key's per-minute limit was passed. */
export class RateLimitError extends TukuPayError {
  /** Seconds until the limit resets, from `Retry-After`. */
  readonly retryAfter: number | undefined;

  constructor(message: string, init: { status?: number; errors?: unknown; body?: unknown; retryAfter?: number }) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

/**
 * The payment gateway refused the request although the API answered HTTP 200,
 * for example a wrong OTP on onboarding confirm (`{"status": false, ...}`).
 */
export class GatewayError extends TukuPayError {}

/** 5xx: something failed on TukuPay's side. */
export class APIError extends TukuPayError {}

/** No response: DNS, TLS, a dropped connection or a timeout. */
export class ConnectionError extends TukuPayError {}

/** `transactions.wait` gave up before the transaction left `pending`. */
export class WaitTimeoutError extends TukuPayError {
  /** The transaction as last read, still pending. */
  readonly transaction: unknown;

  constructor(message: string, transaction: unknown) {
    super(message);
    this.transaction = transaction;
  }
}

function describe(errors: unknown): string | undefined {
  if (typeof errors === "string") return errors;
  if (Array.isArray(errors)) {
    const parts = errors.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const text = record.message ?? record.msg ?? record.detail;
        const field = record.field ?? (Array.isArray(record.loc) ? record.loc.join(".") : undefined);
        if (typeof text === "string") return field ? `${String(field)}: ${text}` : text;
      }
      return JSON.stringify(item);
    });
    return parts.join("; ");
  }
  if (errors && typeof errors === "object") {
    const record = errors as Record<string, unknown>;
    const text = record.message ?? record.detail;
    return typeof text === "string" ? text : JSON.stringify(errors);
  }
  return undefined;
}

/** Pulls the human-readable text out of a response body. */
export function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    return describe(record.errors) ?? describe(record.detail) ?? describe(record.message) ?? fallback;
  }
  return typeof body === "string" && body.trim() ? body.trim().slice(0, 300) : fallback;
}

export function errorFromResponse(status: number, body: unknown, headers: Headers): TukuPayError {
  const errors = body && typeof body === "object" ? (body as Record<string, unknown>).errors : undefined;
  const init = { status, errors, body };
  const message = messageFromBody(body, `Request failed with HTTP ${status}`);

  if (status === 401) return new AuthenticationError(message, init);
  if (status === 403) return new PermissionError(message, init);
  if (status === 404) return new NotFoundError(message, init);
  if (status === 400 || status === 422) return new ValidationError(message, init);
  if (status === 429) {
    const seconds = Number(headers.get("retry-after"));
    return new RateLimitError(message, { ...init, retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined });
  }
  if (status >= 500) return new APIError(message, init);
  return new TukuPayError(message, init);
}
