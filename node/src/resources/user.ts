import { randomUUID } from "node:crypto";

import { GatewayError, messageFromBody } from "../errors.js";
import type { RequestOptions, TokenSource, Transport } from "../transport.js";
import type {
  BulkTransferRequest,
  BulkTransferResponse,
  DirectPaymentRequest,
  DirectPaymentResponse,
  Json,
  KycDocument,
  KycUploadResponse,
  Message,
  OnboardCustomerConfirmRequest,
  OnboardCustomerInitialRequest,
  OnboardingStatus,
  PaymentOtpRequest,
  PaymentOtpResponse,
  PinSetupRequest,
  SmsBalance,
  SmsOutbox,
  SmsOutboxFilters,
  SmsQueued,
  SmsRequest,
  Tokens,
  Transaction,
  TransactionList,
  User,
  UserTransactionFilters,
  WaitOptions,
  Wallet,
  WalletCreate,
} from "../types.js";
import { pages, waitForTransaction } from "../wait.js";

export interface PaymentOptions {
  /**
   * Identifies this payment so a repeat is recognised and not paid twice.
   * Generated when left out. Pass your own to make a retry from your side safe
   * across processes, for example your order id.
   */
  idempotencyKey?: string;
}

/**
 * Everything done as one signed-in user. Each call carries the app's key and
 * the user's token, and behaves exactly as it does from TukuPay's own app.
 */
export class UserClient {
  readonly account: UserAccount;
  readonly onboarding: UserOnboarding;
  readonly kyc: UserKyc;
  readonly wallets: UserWallets;
  readonly payments: UserPayments;
  readonly transactions: UserTransactions;
  readonly sms: UserSms;

  constructor(
    transport: Transport,
    private readonly tokenSource: TokenSource,
  ) {
    const call: Call = (method, path, options) => transport.request(method, path, options, tokenSource);
    this.account = new UserAccount(call);
    this.onboarding = new UserOnboarding(call);
    this.kyc = new UserKyc(call);
    this.wallets = new UserWallets(call);
    this.payments = new UserPayments(call);
    this.transactions = new UserTransactions(call);
    this.sms = new UserSms(call);
  }

  /** The user's current tokens, to store between requests. */
  get tokens(): { access_token: string; refresh_token: string | undefined } {
    return { access_token: this.tokenSource.accessToken, refresh_token: this.tokenSource.refreshToken };
  }
}

type Call = <T>(method: string, path: string, options?: RequestOptions) => Promise<T>;

// Some gateway calls answer a refusal with HTTP 200 and {"status": false}.
function raiseIfRefused<T>(body: T): T {
  if (body && typeof body === "object" && (body as Record<string, unknown>).status === false) {
    throw new GatewayError(messageFromBody(body, "The payment gateway refused the request"), {
      status: 200,
      body,
    });
  }
  return body;
}

class UserAccount {
  constructor(private readonly call: Call) {}

  me(): Promise<User> {
    return this.call("GET", "/sdk/user/me");
  }

  /** Sets the user's payment PIN. Required before any wallet debit. */
  setupPin(pin: PinSetupRequest): Promise<Message> {
    return this.call("POST", "/sdk/user/setup-pin", { body: pin });
  }

  verifyPin(pin: string): Promise<Message> {
    return this.call("POST", "/sdk/user/verify-pin", { body: { pin } });
  }

  /** Ends the session. The tokens stop working. */
  logout(): Promise<Message> {
    return this.call("POST", "/sdk/auth/logout");
  }
}

class UserOnboarding {
  constructor(private readonly call: Call) {}

  /** Step 1: starts wallet onboarding. The user receives an OTP by SMS. */
  async initial(details: OnboardCustomerInitialRequest): Promise<Json> {
    return raiseIfRefused(await this.call<Json>("POST", "/sdk/user/onboarding/initial", { body: details }));
  }

  /** Step 2: confirms with the OTP. A wrong OTP raises `GatewayError`. */
  async confirm(confirmation: OnboardCustomerConfirmRequest): Promise<Json> {
    return raiseIfRefused(
      await this.call<Json>("POST", "/sdk/user/onboarding/confirm", { body: confirmation }),
    );
  }

  /** Step 3: uploads the identity documents, as multipart form data. */
  async kyc(form: FormData): Promise<Json> {
    return raiseIfRefused(await this.call<Json>("POST", "/sdk/user/onboarding/kyc", { body: form }));
  }

  /** How far the user is through wallet onboarding and identity checks. */
  status(): Promise<OnboardingStatus> {
    return this.call("GET", "/sdk/user/onboarding/status");
  }
}

class UserKyc {
  constructor(private readonly call: Call) {}

  /** Uploads one KYC document, as multipart form data. */
  upload(form: FormData): Promise<KycUploadResponse> {
    return this.call("POST", "/sdk/user/kyc/", { body: form });
  }

  list(): Promise<KycDocument[]> {
    return this.call("GET", "/sdk/user/kyc/");
  }

  get(documentId: number): Promise<KycDocument> {
    return this.call("GET", `/sdk/user/kyc/${documentId}`);
  }
}

class UserWallets {
  constructor(private readonly call: Call) {}

  list(): Promise<Wallet[]> {
    return this.call("GET", "/sdk/user/wallets/");
  }

  get(walletId: number): Promise<Wallet> {
    return this.call("GET", `/sdk/user/wallets/${walletId}`);
  }

  /** Adds another wallet for a user who already has one. */
  create(wallet: WalletCreate): Promise<Wallet> {
    return this.call("POST", "/sdk/user/wallets/", { body: wallet });
  }
}

class UserPayments {
  constructor(private readonly call: Call) {}

  /** Payment methods currently enabled. */
  methods(options: { include_unavailable?: boolean } = {}): Promise<Json> {
    return this.call("GET", "/sdk/user/payments/payment-methods", { query: options });
  }

  transactionTypes(): Promise<Json> {
    return this.call("GET", "/sdk/user/payments/transaction-types");
  }

  /** Checks a payment without making it: fees, limits and balance. */
  validate(payment: DirectPaymentRequest): Promise<Json> {
    return this.call("POST", "/sdk/user/payments/validate", { body: payment });
  }

  /** Sends the user the OTP that some payments need in addition to the PIN. */
  requestOtp(request: PaymentOtpRequest): Promise<PaymentOtpResponse> {
    return this.call("POST", "/sdk/user/payments/request-otp", { body: request });
  }

  /**
   * Makes a payment. Success here means the payment was *requested*: follow
   * with `transactions.wait(result.transaction_id)` for the outcome, and show
   * the payer any `customer_message` in the response word for word.
   */
  direct(payment: DirectPaymentRequest, options: PaymentOptions = {}): Promise<DirectPaymentResponse> {
    return this.call("POST", "/sdk/user/payments/direct", {
      body: payment,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  /** Pays several recipients from one wallet. */
  bulkTransfer(transfer: BulkTransferRequest, options: PaymentOptions = {}): Promise<BulkTransferResponse> {
    return this.call("POST", "/sdk/user/payments/bulk-transfer", {
      body: transfer,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }
}

class UserTransactions {
  constructor(private readonly call: Call) {}

  list(filters: UserTransactionFilters = {}): Promise<TransactionList> {
    return this.call("GET", "/sdk/user/transactions/", { query: filters });
  }

  /** One transaction. Never cached, so safe to poll. */
  get(transactionId: number): Promise<Transaction> {
    return this.call("GET", `/sdk/user/transactions/${transactionId}`);
  }

  /** Polls until the transaction is `completed` or `failed`. */
  wait(transactionId: number, options?: WaitOptions): Promise<Transaction> {
    return waitForTransaction(() => this.get(transactionId), options);
  }

  iterate(
    filters: Omit<UserTransactionFilters, "limit" | "offset"> = {},
    pageSize = 100,
  ): AsyncGenerator<Transaction, void, undefined> {
    return pages(async (page) => {
      const result = await this.list({ ...filters, ...page });
      return { items: result.transactions, hasMore: result.has_more };
    }, pageSize);
  }
}

class UserSms {
  constructor(private readonly call: Call) {}

  /** Queues an SMS on this user's account and credits. */
  send(message: SmsRequest): Promise<SmsQueued> {
    return this.call("POST", "/sdk/user/sms/send", { body: message });
  }

  outbox(filters: SmsOutboxFilters = {}): Promise<SmsOutbox> {
    return this.call("GET", "/sdk/user/sms/outbox", { query: filters });
  }

  /** The user's SMS credit balance. */
  balance(): Promise<SmsBalance> {
    return this.call("GET", "/sdk/user/sms/balance");
  }
}

/** Builds the shared token holder for one user. */
export function createTokenSource(
  session: { access_token: string; refresh_token?: string | null },
  refresh: (refreshToken: string) => Promise<Tokens>,
  onTokenRefresh?: (tokens: Tokens) => void | Promise<void>,
): TokenSource {
  let inFlight: Promise<void> | undefined;

  const source: TokenSource = {
    accessToken: session.access_token,
    refreshToken: session.refresh_token ?? undefined,
    refresh() {
      // One renewal at a time: the API revokes a refresh token on use, so two
      // parallel renewals would leave one of them holding a dead token.
      inFlight ??= (async () => {
        try {
          const tokens = await refresh(source.refreshToken as string);
          source.accessToken = tokens.access_token;
          source.refreshToken = tokens.refresh_token;
          await onTokenRefresh?.(tokens);
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    },
  };
  return source;
}
