import { ConnectionError, RateLimitError, errorFromResponse, messageFromBody } from "./errors.js";
import { VERSION } from "./version.js";

export type QueryValue = string | number | boolean | Date | null | undefined;

export interface RequestOptions {
  query?: object;
  /** Sent as JSON, unless it is a `FormData`, which is sent as multipart. */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Sent as `Idempotency-Key`. Only `/payments/direct` and
   * `/payments/bulk-transfer` honour it; with it set, a failed POST is retried.
   */
  idempotencyKey?: string;
  /** Overrides the client's timeout for this call. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  fetch: typeof fetch;
  debug?: (line: string) => void;
}

/** A user's tokens, and how to renew them. Shared by every call made as that user. */
export interface TokenSource {
  accessToken: string;
  refreshToken: string | undefined;
  /** Renews the tokens in place. Concurrent callers share one renewal. */
  refresh(): Promise<void>;
}

const API_PREFIX = "/api/v1";
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

// The API's wording for a missing, expired, revoked or malformed access token.
const TOKEN_MESSAGE = /authentication credentials|token|not authenticated|authentication required/i;
const NOT_A_TOKEN_MESSAGE = /api key|refresh token|\bpin\b/i;

function isTokenProblem(message: string): boolean {
  return message === "" || (TOKEN_MESSAGE.test(message) && !NOT_A_TOKEN_MESSAGE.test(message));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Exponential backoff with full jitter: 0.5s, 1s, 2s ... each scaled by 0.5-1.
function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt * (0.5 + Math.random() / 2);
}

export class Transport {
  constructor(private readonly options: TransportOptions) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}, tokens?: TokenSource): Promise<T> {
    const verb = method.toUpperCase();
    const url = this.buildUrl(path, options.query);
    // A POST is only safe to send twice when the endpoint will recognise the repeat.
    const repeatable = verb === "GET" || verb === "HEAD" || Boolean(options.idempotencyKey);

    let attempt = 0;
    let refreshed = false;

    for (;;) {
      let response: Response;
      try {
        response = await this.send(verb, url, options, tokens);
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (repeatable && attempt < this.options.maxRetries) {
          await sleep(backoffMs(attempt++));
          continue;
        }
        const timedOut = cause instanceof Error && cause.name === "TimeoutError";
        throw new ConnectionError(
          timedOut ? `Request to ${verb} ${path} timed out` : `Could not reach TukuPay for ${verb} ${path}`,
          { cause },
        );
      }

      this.options.debug?.(`${verb} ${path} -> ${response.status}`);
      const body = await parseBody(response);
      if (response.ok) return body as T;

      // An expired access token is renewed once. Other things also answer 401 and
      // must not be repeated: a rejected API key, and above all a wrong PIN, where
      // a silent second try would cost the user another attempt before lockout.
      if (response.status === 401 && tokens?.refreshToken && !refreshed && isTokenProblem(messageFromBody(body, ""))) {
        refreshed = true;
        await tokens.refresh();
        continue;
      }

      const error = errorFromResponse(response.status, body, response.headers);
      const retryable = response.status === 429 || (repeatable && RETRYABLE_STATUSES.has(response.status));
      if (retryable && attempt < this.options.maxRetries) {
        const wait =
          error instanceof RateLimitError && error.retryAfter !== undefined
            ? error.retryAfter * 1000
            : backoffMs(attempt);
        if (wait <= this.options.maxRetryDelayMs) {
          attempt++;
          await sleep(wait);
          continue;
        }
      }
      throw error;
    }
  }

  private buildUrl(path: string, query?: object): string {
    const url = new URL(this.options.baseUrl + API_PREFIX + (path.startsWith("/") ? path : `/${path}`));
    for (const [name, value] of Object.entries(query ?? {}) as [string, QueryValue][]) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(name, value instanceof Date ? value.toISOString() : String(value));
    }
    return url.toString();
  }

  private send(verb: string, url: string, options: RequestOptions, tokens?: TokenSource): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `tukupay-node/${VERSION}`,
      ...options.headers,
      "X-API-Key": this.options.apiKey,
    };
    if (tokens && !headers.Authorization) headers.Authorization = `Bearer ${tokens.accessToken}`;
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    let body: BodyInit | undefined;
    if (options.body instanceof FormData) {
      body = options.body; // fetch sets the multipart boundary itself
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return this.options.fetch(url, { method: verb, headers, body, signal });
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
