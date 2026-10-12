import { AppResource } from "./resources/app.js";
import { AuthResource } from "./resources/auth.js";
import { UserClient, createTokenSource } from "./resources/user.js";
import { Transport } from "./transport.js";
import type { Tokens } from "./types.js";

const BASE_URLS: Record<string, string> = {
  sk_test_: "https://test.api.tuku.money",
  sk_live_: "https://api.tuku.money",
};

export interface TukuPayOptions {
  /** The app's key: `sk_test_...` or `sk_live_...`. Keep it on the server. */
  apiKey: string;
  /** Defaults to the environment the key belongs to. */
  baseUrl?: string;
  /** Per-request timeout. Default 30 000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** A rate-limit wait longer than this is not waited out but raised. Default 20 000 ms. */
  maxRetryDelayMs?: number;
  /** A replacement for the built-in `fetch`, for proxies or tests. */
  fetch?: typeof fetch;
  /** Logs method, path and status of each call. Never keys, tokens, PINs or bodies. */
  debug?: boolean | ((line: string) => void);
}

export interface AsUserOptions {
  /** Called with the new pair whenever the library renews the user's tokens. Store them. */
  onTokenRefresh?: (tokens: Tokens) => void | Promise<void>;
}

export class TukuPay {
  /** App-level endpoints: the API key alone. */
  readonly app: AppResource;
  /** Register and sign in users. */
  readonly auth: AuthResource;

  private readonly transport: Transport;

  constructor(options: TukuPayOptions) {
    if (!options?.apiKey) {
      throw new TypeError("TukuPay: apiKey is required");
    }
    const prefix = Object.keys(BASE_URLS).find((candidate) => options.apiKey.startsWith(candidate));
    const baseUrl = options.baseUrl ?? (prefix ? BASE_URLS[prefix] : undefined);
    if (!baseUrl) {
      throw new TypeError("TukuPay: apiKey must start with sk_test_ or sk_live_, or pass baseUrl");
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new TypeError("TukuPay: no fetch available; use Node 20 or later, or pass fetch");
    }

    this.transport = new Transport({
      apiKey: options.apiKey,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 20_000,
      fetch: fetchImpl,
      debug: options.debug === true ? (line) => console.debug(`[tukupay] ${line}`) : options.debug || undefined,
    });
    this.app = new AppResource(this.transport);
    this.auth = new AuthResource(this.transport);
  }

  /**
   * A client that acts as one signed-in user. Accepts the result of
   * `auth.login()`, or tokens stored earlier. With a refresh token present, an
   * expired access token is renewed and the call repeated, once.
   */
  asUser(session: { access_token: string; refresh_token?: string | null }, options: AsUserOptions = {}): UserClient {
    if (!session?.access_token) {
      throw new TypeError("TukuPay.asUser: access_token is required");
    }
    const tokens = createTokenSource(session, (refreshToken) => this.auth.refresh(refreshToken), options.onTokenRefresh);
    return new UserClient(this.transport, tokens);
  }
}
