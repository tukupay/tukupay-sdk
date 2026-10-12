import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APIError,
  AuthenticationError,
  ConnectionError,
  GatewayError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  TukuPay,
  ValidationError,
  WaitTimeoutError,
  failureOf,
} from "../src/index.js";
import { client, mockFetch } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("construction", () => {
  it("picks the base URL from the key prefix", async () => {
    for (const [apiKey, host] of [
      ["sk_test_x", "test.api.tuku.money"],
      ["sk_live_x", "api.tuku.money"],
    ] as const) {
      const { fetchImpl, calls } = mockFetch({ body: {} });
      await new TukuPay({ apiKey, fetch: fetchImpl }).app.retrieve();
      expect(calls[0]!.url.host).toBe(host);
      expect(calls[0]!.url.pathname).toBe("/api/v1/sdk/app/");
    }
  });

  it("refuses a missing key and an unrecognised key without a base URL", () => {
    expect(() => new TukuPay({ apiKey: "" })).toThrow(TypeError);
    expect(() => new TukuPay({ apiKey: "legacy-key" })).toThrow(/sk_test_ or sk_live_/);
    expect(() => new TukuPay({ apiKey: "legacy-key", baseUrl: "http://localhost:8000/" })).not.toThrow();
  });
});

describe("requests", () => {
  it("sends the key and a library user agent, and no user token, on app calls", async () => {
    const { fetchImpl, calls } = mockFetch({ body: [] });
    await client(fetchImpl).app.wallets.list({ limit: 5, offset: 10 });
    const call = calls[0]!;
    expect(call.headers["X-API-Key"]).toBe("sk_test_abc");
    expect(call.headers["User-Agent"]).toMatch(/^tukupay-node\/\d/);
    expect(call.headers.Authorization).toBeUndefined();
    expect(call.url.search).toBe("?limit=5&offset=10");
  });

  it("leaves out empty filters and serialises dates", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { transactions: [], has_more: false } });
    await client(fetchImpl).app.transactions.list({
      status: "completed",
      wallet_id: undefined,
      start_date: new Date("2026-10-01T00:00:00Z"),
    });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      status: "completed",
      start_date: "2026-10-01T00:00:00.000Z",
    });
  });

  it("sends key and token together on user calls", async () => {
    const { fetchImpl, calls } = mockFetch({ body: [] });
    await client(fetchImpl).asUser({ access_token: "tok" }).wallets.list();
    expect(calls[0]!.headers["X-API-Key"]).toBe("sk_test_abc");
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
    expect(calls[0]!.url.pathname).toBe("/api/v1/sdk/user/wallets/");
  });

  it("passes FormData through without a JSON content type", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { id: 1 } });
    const form = new FormData();
    form.set("doc_type", "national_id");
    await client(fetchImpl).asUser({ access_token: "tok" }).kyc.upload(form);
    expect(calls[0]!.body).toBe(form);
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
  });
});

describe("auth", () => {
  it("verifies a phone and resends the code", async () => {
    const { fetchImpl, calls } = mockFetch({ body: { message: "ok" } }, { body: { message: "sent" } });
    const tuku = client(fetchImpl);
    await tuku.auth.verifyPhone({ phone_number: "0712345678", otp_code: "123456" });
    await tuku.auth.sendPhoneVerification("0712345678");
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/v1/sdk/auth/verify-phone",
      "/api/v1/sdk/auth/send-phone-verification",
    ]);
    expect(calls[0]!.body).toEqual({ phone_number: "0712345678", otp_code: "123456" });
    expect(calls[1]!.body).toEqual({ phone_number: "0712345678" });
  });
});

describe("errors", () => {
  const cases = [
    [401, AuthenticationError],
    [403, PermissionError],
    [404, NotFoundError],
    [400, ValidationError],
    [422, ValidationError],
    [500, APIError],
  ] as const;

  for (const [status, type] of cases) {
    it(`maps ${status} to ${type.name}`, async () => {
      const { fetchImpl } = mockFetch({ status, body: { errors: "Nope" } });
      const error = await client(fetchImpl, { maxRetries: 0 })
        .app.retrieve()
        .catch((e) => e);
      expect(error).toBeInstanceOf(type);
      expect(error.status).toBe(status);
      expect(error.message).toBe("Nope");
      expect(error.errors).toBe("Nope");
    });
  }

  it("turns a list of field errors into one message and keeps the list", async () => {
    const errors = [{ field: "phone_number", message: "Invalid phone" }, { message: "Bad" }];
    const { fetchImpl } = mockFetch({ status: 422, body: { errors } });
    const error = await client(fetchImpl)
      .auth.login({ phone_number: "x", password: "y" })
      .catch((e) => e);
    expect(error.message).toBe("phone_number: Invalid phone; Bad");
    expect(error.errors).toEqual(errors);
  });

  it("wraps a network failure", async () => {
    const { fetchImpl } = mockFetch(new TypeError("fetch failed"));
    const error = await client(fetchImpl, { maxRetries: 0 })
      .app.retrieve()
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.status).toBeUndefined();
  });

  it("raises GatewayError for a 200 that carries status false", async () => {
    const { fetchImpl } = mockFetch({ body: { status: false, message: "Invalid OTP" } });
    const error = await client(fetchImpl)
      .asUser({ access_token: "tok" })
      .onboarding.confirm({ otp: "000000" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.message).toBe("Invalid OTP");
  });
});

describe("retries", () => {
  it("retries a GET on 503 and on a dropped connection", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 503 }, new TypeError("fetch failed"), { body: { id: 1 } });
    await expect(client(fetchImpl).app.retrieve()).resolves.toEqual({ id: 1 });
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxRetries", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 503 }, { status: 503 }, { status: 503 });
    await expect(client(fetchImpl).app.retrieve()).rejects.toBeInstanceOf(APIError);
    expect(calls).toHaveLength(3);
  });

  it("never repeats a POST that has no idempotency key", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 503 });
    await expect(
      client(fetchImpl).app.sms.send({ phone_numbers: ["0700000000"], message: "hi" }),
    ).rejects.toBeInstanceOf(APIError);
    expect(calls).toHaveLength(1);
  });

  it("repeats a payment with the same idempotency key", async () => {
    const { fetchImpl, calls } = mockFetch(new TypeError("fetch failed"), { body: { transaction_id: 9 } });
    const user = client(fetchImpl).asUser({ access_token: "tok" });
    await user.payments.direct({ transaction_data: {}, payment_source: {}, pin: "1234" } as never);
    expect(calls).toHaveLength(2);
    const key = calls[0]!.headers["Idempotency-Key"];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.headers["Idempotency-Key"]).toBe(key);
  });

  it("uses the caller's idempotency key when given", async () => {
    const { fetchImpl, calls } = mockFetch({ body: {} });
    const user = client(fetchImpl).asUser({ access_token: "tok" });
    await user.payments.direct({} as never, { idempotencyKey: "order-42" });
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("order-42");
  });

  it("waits out a short rate limit, and raises a long one", async () => {
    const limited = { status: 429, body: { errors: "Rate limit" }, headers: { "Retry-After": "2" } };
    const short = mockFetch(limited, { body: { id: 1 } });
    await expect(client(short.fetchImpl).app.retrieve()).resolves.toEqual({ id: 1 });

    const long = mockFetch({ ...limited, headers: { "Retry-After": "45" } });
    const error = await client(long.fetchImpl)
      .app.retrieve()
      .catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBe(45);
    expect(long.calls).toHaveLength(1);
  });
});

describe("token refresh", () => {
  const fresh = { access_token: "new", refresh_token: "new-refresh", token_type: "bearer" };

  it("renews an expired token once, repeats the call and reports the new pair", async () => {
    const { fetchImpl, calls } = mockFetch(
      { status: 401, body: { errors: "Token expired" } },
      { body: fresh },
      { body: { id: 7 } },
    );
    const onTokenRefresh = vi.fn();
    const user = client(fetchImpl).asUser({ access_token: "old", refresh_token: "old-refresh" }, { onTokenRefresh });

    await expect(user.account.me()).resolves.toEqual({ id: 7 });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v1/sdk/user/me", "/api/v1/sdk/auth/refresh", "/api/v1/sdk/user/me"]);
    expect(calls[1]!.headers.Authorization).toBe("Bearer old-refresh");
    expect(calls[2]!.headers.Authorization).toBe("Bearer new");
    expect(onTokenRefresh).toHaveBeenCalledWith(fresh);
    expect(user.tokens).toEqual({ access_token: "new", refresh_token: "new-refresh" });
  });

  it("does not loop when the renewed token is refused too", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 401 }, { body: fresh }, { status: 401 });
    const user = client(fetchImpl).asUser({ access_token: "old", refresh_token: "r" });
    await expect(user.account.me()).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(3);
  });

  it("does not spend the refresh token on a rejected API key", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 401, body: { errors: "Invalid or revoked API key" } });
    const user = client(fetchImpl).asUser({ access_token: "old", refresh_token: "r" });
    await expect(user.account.me()).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(1);
  });

  it("does not repeat a wrong PIN", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 401, body: { errors: "Invalid PIN. 2 attempts remaining." } });
    const user = client(fetchImpl).asUser({ access_token: "tok", refresh_token: "r" });
    await expect(user.account.verifyPin("0000")).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toHaveLength(1);
  });

  it("raises straight away without a refresh token", async () => {
    const { fetchImpl, calls } = mockFetch({ status: 401 });
    await expect(client(fetchImpl).asUser({ access_token: "old" }).account.me()).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(calls).toHaveLength(1);
  });

  it("shares one renewal between parallel calls", async () => {
    const { fetchImpl, calls } = mockFetch(
      { status: 401 },
      { status: 401 },
      { body: fresh },
      { body: { n: 1 } },
      { body: { n: 2 } },
    );
    const user = client(fetchImpl).asUser({ access_token: "old", refresh_token: "r" });
    await Promise.all([user.account.me(), user.wallets.list()]);
    expect(calls.filter((c) => c.url.pathname.endsWith("/sdk/auth/refresh"))).toHaveLength(1);
  });
});

describe("transactions", () => {
  it("wait polls until the transaction settles", async () => {
    const { fetchImpl, calls } = mockFetch(
      { body: { id: 5, status: "pending" } },
      { body: { id: 5, status: "pending" } },
      { body: { id: 5, status: "failed", transaction_metadata: { failure: { gateway_code: "1032" } } } },
    );
    const transaction = await client(fetchImpl).app.transactions.wait(5, { intervalMs: 100 });
    expect(calls).toHaveLength(3);
    expect(transaction.status).toBe("failed");
    expect(failureOf(transaction)?.gateway_code).toBe("1032");
  });

  it("wait gives up at the timeout and hands back the last read", async () => {
    const pending = { body: { id: 5, status: "pending" } };
    const { fetchImpl } = mockFetch(pending, pending, pending, pending, pending, pending);
    const error = await client(fetchImpl)
      .app.transactions.wait(5, { intervalMs: 100, timeoutMs: 250 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error.transaction).toEqual({ id: 5, status: "pending" });
  });

  it("iterate walks every page", async () => {
    const { fetchImpl, calls } = mockFetch(
      { body: { transactions: [{ id: 1 }, { id: 2 }], has_more: true } },
      { body: { transactions: [{ id: 3 }], has_more: false } },
    );
    const ids: number[] = [];
    for await (const transaction of client(fetchImpl).app.transactions.iterate({ status: "completed" }, 2)) {
      ids.push(transaction.id);
    }
    expect(ids).toEqual([1, 2, 3]);
    expect(calls[1]!.url.search).toBe("?status=completed&limit=2&offset=2");
  });
});
