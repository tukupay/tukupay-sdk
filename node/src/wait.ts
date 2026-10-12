import { WaitTimeoutError } from "./errors.js";
import type { Transaction, TransactionFailure, WaitOptions } from "./types.js";

/**
 * Reads a transaction until it leaves `pending`.
 *
 * A 200 from a payment endpoint means the payment was requested, not that money
 * moved. This is how the outcome is learned. It resolves for `completed` and for
 * `failed` alike, so check `status` on the result.
 */
export async function waitForTransaction(
  read: () => Promise<Transaction>,
  options: WaitOptions = {},
): Promise<Transaction> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const transaction = await read();
    if (transaction.status !== "pending") return transaction;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WaitTimeoutError(
        `Transaction ${transaction.id} was still pending after ${timeoutMs} ms`,
        transaction,
      );
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, Math.min(intervalMs, remaining));
      function done() {
        options.signal?.removeEventListener("abort", aborted);
        resolve();
      }
      function aborted() {
        clearTimeout(timer);
        reject(options.signal?.reason);
      }
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
    });
  }
}

/** The decoded failure block of a failed transaction, if it has one. */
export function failureOf(transaction: Transaction): TransactionFailure | undefined {
  const metadata = (transaction as { transaction_metadata?: unknown }).transaction_metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const failure = (metadata as Record<string, unknown>).failure;
  return failure && typeof failure === "object" ? (failure as TransactionFailure) : undefined;
}

/** Walks a limit/offset list page by page. */
export async function* pages<T>(
  fetchPage: (page: { limit: number; offset: number }) => Promise<{ items: T[]; hasMore: boolean }>,
  limit = 100,
): AsyncGenerator<T, void, undefined> {
  for (let offset = 0; ; offset += limit) {
    const { items, hasMore } = await fetchPage({ limit, offset });
    yield* items;
    if (!hasMore || items.length === 0) return;
  }
}
