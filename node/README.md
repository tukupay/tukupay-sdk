# @tukupay/sdk

Official Node.js and TypeScript library for the [TukuPay](https://tuku.money) API: register users, give them wallets, collect and send money over M-Pesa, and send SMS, from your own server.

The library handles authentication, errors and safe retries for you, and returns TukuPay's responses unchanged, with TypeScript types generated from the API's own definitions.

> **Beta.** The interface may still change before 1.0. Pin the version you install.

## Contents

- [Install](#install)
- [Before you start](#before-you-start)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Guide](#guide)
  1. [Register a user](#1-register-a-user)
  2. [Sign in and keep the session](#2-sign-in-and-keep-the-session)
  3. [Give the user a wallet](#3-give-the-user-a-wallet)
  4. [Set the payment PIN](#4-set-the-payment-pin)
  5. [Collect money by M-Pesa](#5-collect-money-by-m-pesa)
  6. [Send money](#6-send-money)
  7. [Find out what happened](#7-find-out-what-happened)
  8. [See everything your app has done](#8-see-everything-your-app-has-done)
  9. [Send SMS](#9-send-sms)
- [Errors](#errors)
- [Retries, timeouts and rate limits](#retries-timeouts-and-rate-limits)
- [Configuration](#configuration)
- [Reference](#reference)
- [Troubleshooting](#troubleshooting)

## Install

```bash
npm install @tukupay/sdk@beta
```

Requires Node.js 20 or later. No runtime dependencies. Ships ES modules, CommonJS and TypeScript types.

```js
import { TukuPay } from "@tukupay/sdk";          // ES modules, TypeScript
const { TukuPay } = require("@tukupay/sdk");      // CommonJS
```

## Before you start

TukuPay runs two separate environments. They share nothing: each has its own apps, users, wallets and API keys.

| Environment | Server | Keys it issues | Use it for | Limit |
|---|---|---|---|---|
| **Test** | `https://test.api.tuku.money` | `sk_test_...` | Building and testing your integration | 60 requests a minute |
| **Production** | `https://api.tuku.money` | `sk_live_...` | Real customers | 600 requests a minute |

To use an environment you need, **on that environment**:

1. **A TukuPay app.** Your integration is an *app*. Users you register belong to it, and payments made through it are recorded against it.
2. **An API key for that app.** Keys are issued per app from your TukuPay account; if you do not have one yet, ask your TukuPay contact. The full key is shown **once**, so store it in an environment variable or secret manager.

A key only exists on the environment that issued it. The library reads the prefix and talks to the matching server, so going live is a matter of creating a `sk_live_` key on production and changing one environment variable:

```bash
TUKUPAY_API_KEY=sk_test_...   # testing and development
TUKUPAY_API_KEY=sk_live_...   # production
```

Users, wallets and ids do not carry over: a user registered on the test environment does not exist on production.

> **The test environment is not a sandbox.** A payout made with a test key **moves real money**. When testing, only pay phone numbers you control, and use small amounts.

## How it works

Every request carries up to two credentials. Knowing which is which explains the whole library.

| Credential | Answers | Sent as | Who holds it |
|---|---|---|---|
| **API key** | Which **app** is calling? | `X-API-Key` header | Your server, and nobody else |
| **User token** | Which **user** is acting? | `Authorization: Bearer` header | Your server, one per signed-in user |

- With the **key alone** you can read things about your app as a whole: its wallets, transactions and users, and send SMS. These live under `tuku.app`.
- To act **as a user** (open a wallet, pay, upload KYC) you need the key **and** that user's token, plus their PIN whenever money leaves a wallet. These live on the object returned by `tuku.asUser(tokens)`.

Your users never see the API key. They register and sign in with their phone number and password as on TukuPay itself; your server passes those to TukuPay and keeps the tokens it gets back.

**Never put the API key in a web page, a mobile app or a public repository.** Anyone holding it can act as your app.

## Quick start

Check that your key works:

```ts
import { TukuPay } from "@tukupay/sdk";

const apiKey = process.env.TUKUPAY_API_KEY;
if (!apiKey) throw new Error("TUKUPAY_API_KEY is not set");

const tuku = new TukuPay({ apiKey });

const app = await tuku.app.retrieve();
console.log(app.name, app.status, app.environment);
// My Shop  active  test
```

If this prints your app's name, the key is valid and you are talking to the right environment.

## Guide

The steps below take one user from nothing to a completed payment. Each builds on the one before.

### 1. Register a user

```ts
await tuku.auth.register({
  phone_number: "0712345678",
  password: "a-strong-password",
  accepted_terms: true,
});
```

- Leave `app_id` out. The user is placed under your app because the request carries your key.
- `phone_number` accepts `07XXXXXXXX`, `01XXXXXXXX` or `2547XXXXXXXX`.
- `accepted_terms` must be `true`; the user has to have agreed to TukuPay's terms.

TukuPay texts the user a one-time code. Ask them for it and confirm their phone:

```ts
await tuku.auth.verifyPhone({ phone_number: "0712345678", otp_code: "123456" });
```

A user **cannot sign in until their phone is verified**. If the code did not arrive, send another with `tuku.auth.sendPhoneVerification(phoneNumber)`.

### 2. Sign in and keep the session

```ts
const tokens = await tuku.auth.login({
  phone_number: "0712345678",
  password: "a-strong-password",
});

const user = tuku.asUser(tokens, {
  // Called whenever the library renews the tokens. Save them.
  onTokenRefresh: async (fresh) => {
    await db.saveTokens(userId, fresh.access_token, fresh.refresh_token);
  },
});

const me = await user.account.me();
```

`login` returns two tokens:

| Token | Lifetime | Use |
|---|---|---|
| `access_token` | short | sent with every call made as the user |
| `refresh_token` | longer, **single use** | exchanged for a new pair when the access token expires |

You do not manage this by hand. When a call fails because the access token has expired, the library exchanges the refresh token, repeats the call once, and gives you the new pair through the callback. **Store the new pair every time**: the old refresh token no longer works, so a stale one means the user has to sign in again.

Sign in once and reuse the tokens; signing a user in on every request will hit TukuPay's limit on sign-ins per hour. On a later request, rebuild the user from the tokens you stored:

```ts
const saved = await db.loadTokens(userId);

const user = tuku.asUser(
  { access_token: saved.accessToken, refresh_token: saved.refreshToken },
  { onTokenRefresh: (fresh) => db.saveTokens(userId, fresh.access_token, fresh.refresh_token) },
);
```

### 3. Give the user a wallet

A new user has no wallet. Opening one is a three-step identity check.

**Step 1: send their details.** TukuPay texts the user an OTP.

```ts
await user.onboarding.initial({
  first_name: "John",
  middle_name: "K",
  last_name: "Doe",
  country_code: "254",
  document_type: "1",
  document_number: "12345678",
  email: "john@example.com",
});
```

`document_type` is `"1"` for a national ID, `"2"` for a passport and `"3"` for an alien ID.

**Step 2: confirm with the OTP.**

```ts
await user.onboarding.confirm({ otp: "123456" });
```

A wrong or expired OTP raises `GatewayError`; the message says why.

**Step 3: upload the identity documents.**

```ts
import { openAsBlob } from "node:fs";

const form = new FormData();
form.set("passport_size_photo", await openAsBlob("photo.jpg"), "photo.jpg");
form.set("document_image_front", await openAsBlob("id-front.jpg"), "id-front.jpg");
form.set("document_image_back", await openAsBlob("id-back.jpg"), "id-back.jpg");

await user.onboarding.kyc(form);
```

**Check progress** at any time:

```ts
const { status } = await user.onboarding.status();
```

| `status` | Meaning |
|---|---|
| `not_started` | No onboarding yet |
| `pending_otp` | Step 1 done; waiting for the OTP |
| `wallet_created` | Step 2 done; the wallet exists, documents still needed |
| `kyc_uploaded` | Documents sent; verification in progress |
| `verified` | Approved; the wallet is fully usable |
| `rejected` | Verification failed; the user must correct their documents |

Once the wallet exists you can read it:

```ts
const wallets = await user.wallets.list();
const wallet = wallets[0];
console.log(wallet.id, wallet.alias, wallet.balance);
```

### 4. Set the payment PIN

Every payment that takes money **out of** a wallet needs the user's PIN (above KES 50,000, a one-time code sent to their phone instead; see step 6). Set it once:

```ts
await user.account.setupPin({ pin: "1234", confirm_pin: "1234" });
```

The library passes PINs straight to TukuPay and never stores or logs them. Do not store them either; ask the user each time.

### 5. Collect money by M-Pesa

This sends an M-Pesa prompt to a phone and puts the money in the user's wallet.

```ts
const payment = await user.payments.direct({
  transaction_data: {
    transaction_type: "WALLET_TOPUP",
    amount: 150,
    destination_wallet_id: wallet.id,
  },
  payment_source: {
    payment_method: "mpesa",
    phone_number: "0712345678",        // the phone that receives the M-Pesa prompt
  },
  description: "Order 1042",
});

console.log(payment.transaction_id, payment.status);
const instructions = payment.type_result?.customer_message;   // show this to the payer
```

Two things to do with the response:

- **Show the payer `type_result.customer_message` word for word**, if present. Some payers do not receive the M-Pesa prompt, and this text gives them the PayBill steps to pay manually.
- **Do not treat this as paid.** A successful response means the request was *accepted*. The payer still has to enter their M-Pesa PIN. Go to [step 7](#7-find-out-what-happened) for the outcome.

No TukuPay PIN is needed here, because money is coming in.

### 6. Send money

This pays from the user's wallet to an M-Pesa number. Money is leaving a wallet, so the PIN is required.

```ts
const payout = await user.payments.direct({
  transaction_data: {
    transaction_type: "USER_TRANSFER",
    amount: 500,
    transfer_method: "mpesa",
    destination_phone: "0798765432",
  },
  payment_source: {
    payment_method: "tukupay_wallet",
    source_wallet_id: wallet.id,
  },
  pin: "1234",                          // asked from the user, never stored
});
```

**Check first, if you want to show fees or catch problems early.** `validate` takes the same payment and reports fees, limits and whether the balance covers it, without moving money:

```ts
const check = await user.payments.validate(paymentBody);
```

**Above KES 50,000 a one-time code replaces the PIN.** Request the code, collect it from the user, and send the payment with `otp_code` and the `payment_hash` you were given, in place of `pin`:

```ts
const { payment_hash } = await user.payments.requestOtp({
  amount: 75_000,
  transaction_type: "USER_TRANSFER",
  source_wallet_id: wallet.id,
});

await user.payments.direct({ ...paymentBody, otp_code: "654321", payment_hash });
```

Other payment types use the same call with a different `transaction_data`:

| `transaction_type` | Does | Key fields |
|---|---|---|
| `WALLET_TOPUP` | M-Pesa into the user's own wallet | `amount`, `destination_wallet_id` |
| `STK_POS` | M-Pesa prompt to any payer, into a wallet | `amount`, `destination_wallet_id` |
| `USER_TRANSFER` | Wallet to an M-Pesa number or a TukuPay wallet alias | `amount`, `transfer_method`, `destination_phone` or `destination_alias` |
| `WALLET_TRANSFER` | Between two TukuPay wallets | `amount`, `destination_wallet_id` |
| `BANK_TRANSFER` | Wallet to a bank account | `amount`, `bank_name`, `account_number`, `account_name` |
| `BILL_PAYMENT` | Pay a Paybill or Till | `amount`, `receiver_merchant_code`, `account_reference`, `reason` |

`user.payments.transactionTypes()` lists every type available to you with a short description. For a type or field not covered here, ask your TukuPay contact. To pay many M-Pesa numbers from one wallet in one call, use `user.payments.bulkTransfer()`.

#### Paying twice by accident

Networks fail at the worst moment: your request may reach TukuPay while the reply never reaches you. To make a repeat safe, every payment carries an **idempotency key**. TukuPay remembers it, and a second request with the same key returns the first result without paying again.

- The library generates one per call and reuses it for its own automatic retries. You get this for free.
- If **your** code may retry (a queue job that can run twice, a user double-clicking), pass your own key built from something stable such as your order id:

```ts
await user.payments.direct(paymentBody, { idempotencyKey: `order-${order.id}-attempt-1` });
```

- A deliberate **new attempt** after a failure is a new payment and needs a **new** key. Reusing the old key returns the old failure.

### 7. Find out what happened

A payment starts as `pending` and ends as `completed` or `failed`. `wait` reads it until it settles:

```ts
import { failureOf, WaitTimeoutError } from "@tukupay/sdk";

try {
  const transaction = await user.transactions.wait(payment.transaction_id, {
    timeoutMs: 120_000,     // give up after 2 minutes
    intervalMs: 3_000,      // check every 3 seconds
  });

  if (transaction.status === "completed") {
    await markOrderPaid(order.id);
  } else {
    const failure = failureOf(transaction);
    console.log(failure?.category, failure?.hint);
    // cancelled_by_payer  The payer cancelled the STK prompt on their handset.
  }
} catch (error) {
  if (error instanceof WaitTimeoutError) {
    // Still pending. Keep the id and check again later.
  } else {
    throw error;
  }
}
```

`wait` returns for both outcomes, so always check `status`. If time runs out it raises `WaitTimeoutError`; the payment may still complete later, so keep the transaction id and check again rather than assuming failure.

`wait` holds the request open while it polls. In a web handler it is usually better to return to the user straight away and check the outcome from a background job or when they reload the page, using `transactions.get(id)`.

When a payment fails, `failureOf(transaction)` gives the reason in a form you can act on:

| Field | Meaning |
|---|---|
| `category` | A stable label, e.g. `cancelled_by_payer` |
| `gateway_code` | The gateway's specific code, e.g. `1032`. Use this, not `code` |
| `hint` | A plain-language explanation |
| `retryable` | Whether trying again could succeed |
| `code` | The gateway's general code; nearly always the same generic value |

### 8. See everything your app has done

These calls need only the API key and cover every user of your app. They suit back-office screens, reconciliation and reports.

```ts
const wallets = await tuku.app.wallets.list({ limit: 50 });
const wallet = await tuku.app.wallets.get(28);

const page = await tuku.app.transactions.list({
  status: "completed",
  start_date: new Date("2026-10-01"),
  limit: 100,
});
console.log(page.total, page.has_more);

const transaction = await tuku.app.transactions.get(1042);
const { users, total } = await tuku.app.users.list({ limit: 20 });
```

Lists return at most 100 rows per call. To walk a whole list without handling pages yourself:

```ts
for await (const transaction of tuku.app.transactions.iterate({ status: "completed" })) {
  console.log(transaction.id, transaction.amount);
}
```

Transaction filters: `transaction_type`, `status` (`pending`, `completed`, `failed`), `wallet_id`, `start_date`, `end_date`, `limit`, `offset`.

Your key only ever sees your own app. Asking for another app's wallet or transaction gives `NotFoundError`, the same as one that does not exist.

### 9. Send SMS

Messages go out on the app owner's TukuPay account and use the owner's SMS credits.

```ts
const queued = await tuku.app.sms.send({
  phone_numbers: ["0712345678", "0798765432"],
  message: "Your order has shipped.",
});

const outbox = await tuku.app.sms.outbox({ limit: 20 });
const one = await tuku.app.sms.status(outbox[0].id);
console.log(one.phone_number, one.status);
```

- `send` queues the message. The `message_id` it returns identifies the queued batch, not the individual texts.
- To see what was delivered, read the outbox. Each row is one recipient, with a `status` of `success`, `failed` or `pending`.
- Credits are taken when the message is actually sent, not when it is queued.
- A custom `sender_id` must be one approved on the owner's account.

## Errors

Every failure raises a `TukuPayError` or one of its subclasses. Each carries:

- `error.message`: a readable message.
- `error.status`: the HTTP status, or `undefined` if no response arrived.
- `error.errors`: exactly what the API sent in `errors`. For a validation failure this is a list with one entry per bad field.
- `error.body`: the whole response body.

| Class | HTTP | When | What to do |
|---|---|---|---|
| `AuthenticationError` | 401 | Key or token missing, wrong, revoked, expired, or for the other environment | Check the key; sign the user in again |
| `PermissionError` | 403 | Not allowed: a wrong or locked PIN, an unverified phone, an app that is suspended or pending | Read the message. For a wrong PIN, ask the user again; never retry on your own |
| `NotFoundError` | 404 | Does not exist, or belongs to another app | Check the id |
| `ValidationError` | 400, 422 | The request was refused as sent | Fix the fields named in `errors` |
| `RateLimitError` | 429 | Too many requests this minute | Wait `error.retryAfter` seconds |
| `GatewayError` | 200 | The payment gateway refused, e.g. a wrong onboarding OTP | Show the message; let the user retry |
| `APIError` | 5xx | A fault on TukuPay's side | Retry later; contact TukuPay if it persists |
| `ConnectionError` | none | No response: network failure or timeout | Retry; for a payment, reuse the same idempotency key |
| `WaitTimeoutError` | none | `wait` ran out of time | Check the transaction again later |

```ts
import { RateLimitError, TukuPayError, ValidationError } from "@tukupay/sdk";

try {
  await user.payments.direct(paymentBody);
} catch (error) {
  if (error instanceof ValidationError) {
    showToUser(error.message);                 // "amount: Input should be greater than 0"
  } else if (error instanceof RateLimitError) {
    await retryIn(error.retryAfter);
  } else if (error instanceof TukuPayError) {
    log(error.status, error.errors);
  } else {
    throw error;
  }
}
```

## Retries, timeouts and rate limits

**Retries.** A failed call is retried up to twice, waiting a little longer each time.

| Situation | Retried? |
|---|---|
| A read (`GET`) fails with a network error or 502/503/504 | Yes |
| Any call gets 429 | Yes, after the wait the API asks for, if that is 20 seconds or less |
| A payment (`direct`, `bulkTransfer`) fails with a network error or 502/503/504 | Yes, with the same idempotency key |
| Any other write (register, SMS, onboarding) fails | **No.** It is sent once, because repeating it could do the thing twice |

**Timeouts.** Each request is given 30 seconds by default.

**Rate limits.** Limits are per key, per minute. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. If you are regularly limited, spread the work out or ask TukuPay to raise the limit on your key.

## Configuration

```ts
const tuku = new TukuPay({
  apiKey,
  timeoutMs: 30_000,
  maxRetries: 2,
  debug: true,
});
```

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | required | Your app's key |
| `baseUrl` | from the key | Override the server, e.g. `http://localhost:8000` for local development |
| `timeoutMs` | `30000` | Time allowed for each request |
| `maxRetries` | `2` | Retries after the first attempt; `0` turns retrying off |
| `maxRetryDelayMs` | `20000` | A rate-limit wait longer than this is raised instead of waited out |
| `fetch` | built-in | Your own `fetch`, for a proxy or for tests |
| `debug` | `false` | `true` logs each call's method, path and status; or pass a function to receive the line. Keys, tokens, PINs and bodies are never logged |

## Reference

Every call returns a promise. Request and response types are exported from the package, for example `Wallet`, `Transaction`, `DirectPaymentRequest`.

### `tuku.app`: the API key alone

| Call | Returns |
|---|---|
| `tuku.app.retrieve()` | The app this key belongs to: `id`, `name`, `status`, `app_type`, `key_type`, `environment` |
| `tuku.app.wallets.list({ limit, offset })` | Array of the app's wallets |
| `tuku.app.wallets.get(walletId)` | One wallet |
| `tuku.app.wallets.iterate(pageSize?)` | Async iterator over every wallet |
| `tuku.app.transactions.list(filters)` | `{ transactions, total, size, page, has_more }` |
| `tuku.app.transactions.get(transactionId)` | One transaction; never cached |
| `tuku.app.transactions.wait(transactionId, { timeoutMs, intervalMs })` | The transaction once it is `completed` or `failed` |
| `tuku.app.transactions.iterate(filters, pageSize?)` | Async iterator over every matching transaction |
| `tuku.app.users.list({ limit, offset })` | `{ app_id, users, total, size, page, has_more }` |
| `tuku.app.users.iterate(pageSize?)` | Async iterator over every user |
| `tuku.app.sms.send({ phone_numbers, message, sender_id? })` | `{ success, message, message_id, recipient_count, queued_at }` |
| `tuku.app.sms.outbox({ limit, offset })` | Array of sent messages, newest first |
| `tuku.app.sms.status(smsId)` | One message from the outbox |

### `tuku.auth`: the API key alone

| Call | Returns |
|---|---|
| `tuku.auth.register({ phone_number, password, accepted_terms })` | `{ message }`; the user is texted an OTP |
| `tuku.auth.verifyPhone({ phone_number, otp_code })` | `{ message }` |
| `tuku.auth.sendPhoneVerification(phoneNumber)` | `{ message }`; sends the OTP again |
| `tuku.auth.login({ phone_number, password })` | `{ access_token, refresh_token, token_type }` |
| `tuku.auth.refresh(refreshToken)` | A new token pair. Normally the library does this for you |
| `tuku.asUser(tokens, { onTokenRefresh })` | A client that acts as that user |

### As a user: key and token

Obtained from `tuku.asUser(tokens)`.

| Call | Returns |
|---|---|
| `user.tokens` | The user's current `{ access_token, refresh_token }` |
| `user.account.me()` | The user's profile |
| `user.account.setupPin({ pin, confirm_pin })` | `{ message }` |
| `user.account.verifyPin(pin)` | `{ message }`; raises if the PIN is wrong |
| `user.account.logout()` | `{ message }`; the tokens stop working |
| `user.onboarding.initial(details)` | The gateway's reply; the user is texted an OTP |
| `user.onboarding.confirm({ otp, request_id? })` | The gateway's reply; the wallet now exists |
| `user.onboarding.kyc(formData)` | The gateway's reply |
| `user.onboarding.status()` | `{ status, wallet_count, ... }`; see the status table in step 3 |
| `user.kyc.upload(formData)` | `{ document, analysis, message }`. Fields: `doc_type`, `file` |
| `user.kyc.list()` | Array of the user's KYC documents |
| `user.kyc.get(documentId)` | One KYC document |
| `user.wallets.list()` | Array of the user's wallets |
| `user.wallets.get(walletId)` | One wallet |
| `user.wallets.create(wallet)` | A further wallet for a user who already has one |
| `user.payments.methods({ include_unavailable? })` | The payment methods currently enabled |
| `user.payments.transactionTypes()` | The transaction types and their fields |
| `user.payments.validate(payment)` | Fees, limits and balance check; no money moves |
| `user.payments.requestOtp({ amount, transaction_type, source_wallet_id? })` | `{ message, payment_hash, expires_in }` |
| `user.payments.direct(payment, { idempotencyKey? })` | `{ status, message, transaction_id, transaction_type, amount, payment_method, type_result, ... }` |
| `user.payments.bulkTransfer(transfer, { idempotencyKey? })` | `{ status, transaction_id, total_recipients, successful_transfers, failed_transfers, transfer_results, ... }` |
| `user.transactions.list(filters)` | `{ transactions, total, size, page, has_more }` |
| `user.transactions.get(transactionId)` | One transaction; never cached |
| `user.transactions.wait(transactionId, { timeoutMs, intervalMs })` | The transaction once it is `completed` or `failed` |
| `user.transactions.iterate(filters, pageSize?)` | Async iterator over every matching transaction |
| `user.sms.send({ phone_numbers, message, sender_id? })` | Queues an SMS on the user's own credits |
| `user.sms.outbox(filters)` | `{ sms_records, total, size, page, has_more }` |
| `user.sms.balance()` | `{ sms_balance, total_spent, total_earned, ... }` |

### Helpers

| Call | Returns |
|---|---|
| `failureOf(transaction)` | The failure details of a failed transaction, or `undefined` |
| `VERSION` | The library version |

## Troubleshooting

**`Invalid or revoked API key`.** One of:

- The key is mistyped or was revoked.
- It was rotated more than 24 hours ago, so the old key has expired.
- It belongs to the other environment. A `sk_test_` key is unknown to production and a `sk_live_` key is unknown to the test environment. Remove any base URL override so the library picks the server from the key.

**`App not approved or not found`.** Your app has not been approved yet or has been suspended. Contact TukuPay.

**`Please verify your phone number before logging in`.** Finish [step 1](#1-register-a-user): confirm the OTP.

**`Too many login attempts`.** TukuPay allows a limited number of sign-ins per user per hour (about 10). Sign a user in once, store the tokens and reuse them; do not sign in on every request.

**The user is asked to sign in again unexpectedly.** A refresh token was used twice. Make sure the token callback saves the new pair, and that two servers are not refreshing the same user from the same old token.

**`Incorrect PIN` or `PIN is locked`.** The user entered the wrong PIN. Ask them again. After several wrong attempts the PIN locks for a while, so never retry a payment automatically after this error.

**A payment stays `pending`.** The payer has not responded to the M-Pesa prompt, or the gateway has not reported back yet. Keep checking the same transaction; do not start a second payment for the same order.

**I retried and got the same failure.** You reused the idempotency key. A new attempt needs a new key.

## Versioning

This library follows [semantic versioning](https://semver.org). While it is `0.x`, a minor release may change the interface; see [CHANGELOG.md](CHANGELOG.md). It ignores response fields it does not know, so additions to the API do not break it.

## Support

Report problems at https://github.com/tukupay/tukupay-sdk/issues. Never include an API key, token or PIN in an issue.

## License

MIT
