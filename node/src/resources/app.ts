import type { Transport } from "../transport.js";
import type {
  App,
  AppTransactionFilters,
  AppUser,
  AppUsers,
  Page,
  SentSms,
  SmsQueued,
  SmsRequest,
  Transaction,
  TransactionList,
  WaitOptions,
  Wallet,
} from "../types.js";
import { pages, waitForTransaction } from "../wait.js";

/**
 * App-level endpoints (`/sdk/*`): the only ones that work with the API key
 * alone. They cover the app as a whole and are read-only, apart from SMS.
 */
export class AppResource {
  readonly wallets: AppWallets;
  readonly transactions: AppTransactions;
  readonly users: AppUsersResource;
  readonly sms: AppSms;

  constructor(private readonly transport: Transport) {
    this.wallets = new AppWallets(transport);
    this.transactions = new AppTransactions(transport);
    this.users = new AppUsersResource(transport);
    this.sms = new AppSms(transport);
  }

  /** The app this key belongs to. Also the quickest check that a key works. */
  retrieve(): Promise<App> {
    return this.transport.request("GET", "/sdk/app/");
  }
}

class AppWallets {
  constructor(private readonly transport: Transport) {}

  /** Wallets that belong to this app. */
  list(page: Page = {}): Promise<Wallet[]> {
    return this.transport.request("GET", "/sdk/wallets/", { query: page });
  }

  /** One of the app's wallets. Another app's wallet is a `NotFoundError`. */
  get(walletId: number): Promise<Wallet> {
    return this.transport.request("GET", `/sdk/wallets/${walletId}`);
  }

  iterate(pageSize = 100): AsyncGenerator<Wallet, void, undefined> {
    return pages(async (page) => {
      const items = await this.list(page);
      return { items, hasMore: items.length === page.limit };
    }, pageSize);
  }
}

class AppTransactions {
  constructor(private readonly transport: Transport) {}

  /** Transactions made through this app, newest first. */
  list(filters: AppTransactionFilters = {}): Promise<TransactionList> {
    return this.transport.request("GET", "/sdk/transactions/", { query: filters });
  }

  /** One of the app's transactions. Never cached, so safe to poll. */
  get(transactionId: number): Promise<Transaction> {
    return this.transport.request("GET", `/sdk/transactions/${transactionId}`);
  }

  /** Polls until the transaction is `completed` or `failed`. */
  wait(transactionId: number, options?: WaitOptions): Promise<Transaction> {
    return waitForTransaction(() => this.get(transactionId), options);
  }

  iterate(
    filters: Omit<AppTransactionFilters, "limit" | "offset"> = {},
    pageSize = 100,
  ): AsyncGenerator<Transaction, void, undefined> {
    return pages(async (page) => {
      const result = await this.list({ ...filters, ...page });
      return { items: result.transactions, hasMore: result.has_more };
    }, pageSize);
  }
}

class AppUsersResource {
  constructor(private readonly transport: Transport) {}

  /** Users registered under this app. */
  list(page: Page = {}): Promise<AppUsers> {
    return this.transport.request("GET", "/sdk/users/", { query: page });
  }

  iterate(pageSize = 100): AsyncGenerator<AppUser, void, undefined> {
    return pages(async (page) => {
      const result = await this.list(page);
      return { items: result.users, hasMore: result.has_more };
    }, pageSize);
  }
}

class AppSms {
  constructor(private readonly transport: Transport) {}

  /**
   * Queues an SMS on the app owner's account, using the owner's SMS credits.
   * The returned `message_id` identifies the queued batch; it cannot be used
   * with `status`. Read `outbox` to find the delivered messages.
   */
  send(message: SmsRequest): Promise<SmsQueued> {
    return this.transport.request("POST", "/sdk/sms/send", { body: message });
  }

  /** Messages sent on the app owner's account, newest first. */
  outbox(page: Page = {}): Promise<SentSms[]> {
    return this.transport.request("GET", "/sdk/sms/outbox", { query: page });
  }

  /** One message from the outbox, by its outbox `id`. */
  status(smsId: number): Promise<SentSms> {
    return this.transport.request("GET", `/sdk/sms/status/${smsId}`);
  }
}
