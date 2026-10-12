import { TukuPay, type TukuPayOptions } from "../src/index.js";

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A stand-in for fetch that replays queued replies and records what was sent. */
export function mockFetch(...replies: Reply[]) {
  const calls: Recorded[] = [];
  const queue = [...replies];

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = init.body;
    calls.push({
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: init.headers as Record<string, string>,
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    });
    const reply = queue.shift();
    if (!reply) throw new Error("mockFetch: no reply queued");
    if (reply instanceof Error) throw reply;
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return new Response(text || null, { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

export function client(fetchImpl: typeof fetch, options: Partial<TukuPayOptions> = {}) {
  return new TukuPay({ apiKey: "sk_test_abc", fetch: fetchImpl, ...options });
}
