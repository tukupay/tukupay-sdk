// Request and response shapes (generated: `npm run generate`).
import type { components } from "./generated/api.js";

type Schemas = components["schemas"];

export type App = Schemas["SDKAppOut"];
export type AppUsers = Schemas["AppUsersResponse"];
export type AppUser = Schemas["AppUserSummary"];

export type Wallet = Schemas["WalletOut"];
export type WalletCreate = Schemas["SasaPayWalletCreate"];

export type Transaction = Schemas["TransactionWithWallets"];
export type TransactionList = Schemas["TransactionListResponse"];

export type SmsRequest = Schemas["SMSRequest"];
export type SmsQueued = Schemas["SMSQueueResponse"];
export type SentSms = Schemas["SentSMSOut"];
export type SmsOutbox = Schemas["SMSOutboxListResponse"];
export type SmsBalance = Schemas["SMSBalanceOut"];

export type RegisterRequest = Schemas["UserCreate"];
export type PhoneVerification = Schemas["OTPVerifyRequest"];
export type LoginRequest = Schemas["UserLogin"];
export type Tokens = Schemas["LoginResponse"];
export type Message = Schemas["MessageResponse"];
export type User = Schemas["UserResponse"];
export type OnboardingStatus = Schemas["SasaPayStatusResponse"];
export type PinSetupRequest = Schemas["PINSetupRequest"];

export type DirectPaymentRequest = Schemas["DirectPaymentCreate"];
export type DirectPaymentResponse = Schemas["DirectPaymentResponse"];
export type PaymentOtpRequest = Schemas["PaymentOTPRequest"];
export type PaymentOtpResponse = Schemas["PaymentOTPResponse"];
export type BulkTransferRequest = Schemas["BulkTransferTransaction"];
export type BulkTransferResponse = Schemas["BulkTransferResponse"];

export type OnboardCustomerInitialRequest = Schemas["OnboardCustomerInitialRequest"];
export type OnboardCustomerConfirmRequest = Schemas["OnboardCustomerConfirmRequest"];

export type KycDocument = Schemas["KYCDocumentOut"];
export type KycUploadResponse = Schemas["KYCUploadResponse"];

/** Endpoints the API has not given a response model yet return plain JSON. */
export type Json = Record<string, unknown>;

export interface Page {
  limit?: number;
  offset?: number;
}

export interface AppTransactionFilters extends Page {
  transaction_type?: string;
  status?: "pending" | "completed" | "failed";
  wallet_id?: number;
  start_date?: string | Date;
  end_date?: string | Date;
}

export interface UserTransactionFilters extends AppTransactionFilters {
  transaction_id?: number;
  min_amount?: number;
  max_amount?: number;
  search?: string;
}

export interface SmsOutboxFilters extends Page {
  status?: string;
  phone_number?: string;
  search?: string;
}

export interface WaitOptions {
  /** Give up after this long. Default 120 000 ms. */
  timeoutMs?: number;
  /** Time between reads. Default 3 000 ms. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/** The decoded reason a transaction failed, from `transaction_metadata.failure`. */
export interface TransactionFailure {
  /** The gateway's general code; nearly always the same generic value. */
  code?: string;
  /** The code that actually says what happened, e.g. `1032`. */
  gateway_code?: string;
  reason?: string;
  category?: string;
  retryable?: boolean;
  hint?: string;
  failed_at?: string;
  [key: string]: unknown;
}
