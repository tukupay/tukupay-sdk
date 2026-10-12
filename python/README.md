# tukupay

Official Python library for the [TukuPay](https://tuku.money) API: register users, give them wallets, collect and send money over M-Pesa, and send SMS, from your own server.

The library handles authentication, errors and safe retries for you, and returns TukuPay's responses unchanged, as plain dicts.

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
pip install --pre tukupay
```

Requires Python 3.9 or later. Its only dependency is `httpx`.

`--pre` is needed while the library is in beta; without it `pip` skips pre-release versions.

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
- To act **as a user** (open a wallet, pay, upload KYC) you need the key **and** that user's token, plus their PIN whenever money leaves a wallet. These live on the object returned by `tuku.as_user(tokens)`.

Your users never see the API key. They register and sign in with their phone number and password as on TukuPay itself; your server passes those to TukuPay and keeps the tokens it gets back.

**Never put the API key in a web page, a mobile app or a public repository.** Anyone holding it can act as your app.

## Quick start

Check that your key works:

```python
import os
from tukupay import TukuPay

tuku = TukuPay(os.environ["TUKUPAY_API_KEY"])

app = tuku.app.retrieve()
print(app["name"], app["status"], app["environment"])
# My Shop  active  test
```

If this prints your app's name, the key is valid and you are talking to the right environment.

## Guide

The steps below take one user from nothing to a completed payment. Each builds on the one before.

### 1. Register a user

```python
tuku.auth.register(
    phone_number="0712345678",
    password="a-strong-password",
    accepted_terms=True,
)
```

- Leave `app_id` out. The user is placed under your app because the request carries your key.
- `phone_number` accepts `07XXXXXXXX`, `01XXXXXXXX` or `2547XXXXXXXX`.
- `accepted_terms` must be `true`; the user has to have agreed to TukuPay's terms.

TukuPay texts the user a one-time code. Ask them for it and confirm their phone:

```python
tuku.auth.verify_phone(phone_number="0712345678", otp_code="123456")
```

A user **cannot sign in until their phone is verified**. If the code did not arrive, send another with `tuku.auth.send_phone_verification(phone_number)`.

### 2. Sign in and keep the session

```python
tokens = tuku.auth.login(phone_number="0712345678", password="a-strong-password")

def save_tokens(fresh):
    # Called whenever the library renews the tokens. Save them.
    db.save_tokens(user_id, fresh["access_token"], fresh["refresh_token"])

user = tuku.as_user(tokens, on_token_refresh=save_tokens)

me = user.account.me()
```

`login` returns two tokens:

| Token | Lifetime | Use |
|---|---|---|
| `access_token` | short | sent with every call made as the user |
| `refresh_token` | longer, **single use** | exchanged for a new pair when the access token expires |

You do not manage this by hand. When a call fails because the access token has expired, the library exchanges the refresh token, repeats the call once, and gives you the new pair through the callback. **Store the new pair every time**: the old refresh token no longer works, so a stale one means the user has to sign in again.

Sign in once and reuse the tokens; signing a user in on every request will hit TukuPay's limit on sign-ins per hour. On a later request, rebuild the user from the tokens you stored:

```python
saved = db.load_tokens(user_id)

user = tuku.as_user(
    access_token=saved.access_token,
    refresh_token=saved.refresh_token,
    on_token_refresh=save_tokens,
)
```

### 3. Give the user a wallet

A new user has no wallet. Opening one is a three-step identity check.

**Step 1: send their details.** TukuPay texts the user an OTP.

```python
user.onboarding.initial(
    first_name="John",
    middle_name="K",
    last_name="Doe",
    country_code="254",
    document_type="1",
    document_number="12345678",
    email="john@example.com",
)
```

`document_type` is `"1"` for a national ID, `"2"` for a passport and `"3"` for an alien ID.

**Step 2: confirm with the OTP.**

```python
user.onboarding.confirm(otp="123456")
```

A wrong or expired OTP raises `GatewayError`; the message says why.

**Step 3: upload the identity documents.**

```python
with open("photo.jpg", "rb") as photo, open("id-front.jpg", "rb") as front, open("id-back.jpg", "rb") as back:
    user.onboarding.kyc(files={
        "passport_size_photo": ("photo.jpg", photo, "image/jpeg"),
        "document_image_front": ("id-front.jpg", front, "image/jpeg"),
        "document_image_back": ("id-back.jpg", back, "image/jpeg"),
    })
```

**Check progress** at any time:

```python
status = user.onboarding.status()["status"]
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

```python
wallets = user.wallets.list()
wallet = wallets[0]
print(wallet["id"], wallet["alias"], wallet["balance"])
```

### 4. Set the payment PIN

Every payment that takes money **out of** a wallet needs the user's PIN (above KES 50,000, a one-time code sent to their phone instead; see step 6). Set it once:

```python
user.account.setup_pin(pin="1234", confirm_pin="1234")
```

The library passes PINs straight to TukuPay and never stores or logs them. Do not store them either; ask the user each time.

### 5. Collect money by M-Pesa

This sends an M-Pesa prompt to a phone and puts the money in the user's wallet.

```python
payment = user.payments.direct({
    "transaction_data": {
        "transaction_type": "WALLET_TOPUP",
        "amount": 150,
        "destination_wallet_id": wallet["id"],
    },
    "payment_source": {
        "payment_method": "mpesa",
        "phone_number": "0712345678",      # the phone that receives the M-Pesa prompt
    },
    "description": "Order 1042",
})

print(payment["transaction_id"], payment["status"])
instructions = (payment.get("type_result") or {}).get("customer_message")   # show this to the payer
```

Two things to do with the response:

- **Show the payer `type_result.customer_message` word for word**, if present. Some payers do not receive the M-Pesa prompt, and this text gives them the PayBill steps to pay manually.
- **Do not treat this as paid.** A successful response means the request was *accepted*. The payer still has to enter their M-Pesa PIN. Go to [step 7](#7-find-out-what-happened) for the outcome.

No TukuPay PIN is needed here, because money is coming in.

### 6. Send money

This pays from the user's wallet to an M-Pesa number. Money is leaving a wallet, so the PIN is required.

```python
payout = user.payments.direct({
    "transaction_data": {
        "transaction_type": "USER_TRANSFER",
        "amount": 500,
        "transfer_method": "mpesa",
        "destination_phone": "0798765432",
    },
    "payment_source": {
        "payment_method": "tukupay_wallet",
        "source_wallet_id": wallet["id"],
    },
    "pin": "1234",                         # asked from the user, never stored
})
```

**Check first, if you want to show fees or catch problems early.** `validate` takes the same payment and reports fees, limits and whether the balance covers it, without moving money:

```python
check = user.payments.validate(payment_body)
```

**Above KES 50,000 a one-time code replaces the PIN.** Request the code, collect it from the user, and send the payment with `otp_code` and the `payment_hash` you were given, in place of `pin`:

```python
otp = user.payments.request_otp(amount=75_000, transaction_type="USER_TRANSFER", source_wallet_id=wallet["id"])

user.payments.direct({**payment_body, "otp_code": "654321", "payment_hash": otp["payment_hash"]})
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

`user.payments.transaction_types()` lists every type available to you with a short description. For a type or field not covered here, ask your TukuPay contact. To pay many M-Pesa numbers from one wallet in one call, use `user.payments.bulk_transfer()`.

#### Paying twice by accident

Networks fail at the worst moment: your request may reach TukuPay while the reply never reaches you. To make a repeat safe, every payment carries an **idempotency key**. TukuPay remembers it, and a second request with the same key returns the first result without paying again.

- The library generates one per call and reuses it for its own automatic retries. You get this for free.
- If **your** code may retry (a queue job that can run twice, a user double-clicking), pass your own key built from something stable such as your order id:

```python
user.payments.direct(payment_body, idempotency_key=f"order-{order.id}-attempt-1")
```

- A deliberate **new attempt** after a failure is a new payment and needs a **new** key. Reusing the old key returns the old failure.

### 7. Find out what happened

A payment starts as `pending` and ends as `completed` or `failed`. `wait` reads it until it settles:

```python
from tukupay import WaitTimeoutError, failure_of

try:
    transaction = user.transactions.wait(
        payment["transaction_id"],
        timeout=120,     # give up after 2 minutes
        interval=3,      # check every 3 seconds
    )
except WaitTimeoutError:
    ...  # Still pending. Keep the id and check again later.
else:
    if transaction["status"] == "completed":
        mark_order_paid(order.id)
    else:
        failure = failure_of(transaction) or {}
        print(failure.get("category"), failure.get("hint"))
        # cancelled_by_payer  The payer cancelled the STK prompt on their handset.
```

`wait` returns for both outcomes, so always check `status`. If time runs out it raises `WaitTimeoutError`; the payment may still complete later, so keep the transaction id and check again rather than assuming failure.

`wait` blocks while it polls. In a web handler it is usually better to return to the user straight away and check the outcome from a background task or when they reload the page, using `transactions.get(id)`.

When a payment fails, `failure_of(transaction)` gives the reason in a form you can act on:

| Field | Meaning |
|---|---|
| `category` | A stable label, e.g. `cancelled_by_payer` |
| `gateway_code` | The gateway's specific code, e.g. `1032`. Use this, not `code` |
| `hint` | A plain-language explanation |
| `retryable` | Whether trying again could succeed |
| `code` | The gateway's general code; nearly always the same generic value |

### 8. See everything your app has done

These calls need only the API key and cover every user of your app. They suit back-office screens, reconciliation and reports.

```python
from datetime import date

wallets = tuku.app.wallets.list(limit=50)
wallet = tuku.app.wallets.get(28)

page = tuku.app.transactions.list(status="completed", start_date=date(2026, 10, 1), limit=100)
print(page["total"], page["has_more"])

transaction = tuku.app.transactions.get(1042)
users = tuku.app.users.list(limit=20)["users"]
```

Lists return at most 100 rows per call. To walk a whole list without handling pages yourself:

```python
for transaction in tuku.app.transactions.iterate(status="completed"):
    print(transaction["id"], transaction["amount"])
```

Transaction filters: `transaction_type`, `status` (`pending`, `completed`, `failed`), `wallet_id`, `start_date`, `end_date`, `limit`, `offset`.

Your key only ever sees your own app. Asking for another app's wallet or transaction gives `NotFoundError`, the same as one that does not exist.

### 9. Send SMS

Messages go out on the app owner's TukuPay account and use the owner's SMS credits.

```python
queued = tuku.app.sms.send(
    phone_numbers=["0712345678", "0798765432"],
    message="Your order has shipped.",
)

outbox = tuku.app.sms.outbox(limit=20)
one = tuku.app.sms.status(outbox[0]["id"])
print(one["phone_number"], one["status"])
```

- `send` queues the message. The `message_id` it returns identifies the queued batch, not the individual texts.
- To see what was delivered, read the outbox. Each row is one recipient, with a `status` of `success`, `failed` or `pending`.
- Credits are taken when the message is actually sent, not when it is queued.
- A custom `sender_id` must be one approved on the owner's account.

## Errors

Every failure raises a `TukuPayError` or one of its subclasses. Each carries:

- `str(error)`: a readable message.
- `error.status`: the HTTP status, or `None` if no response arrived.
- `error.errors`: exactly what the API sent in `errors`. For a validation failure this is a list with one entry per bad field.
- `error.body`: the whole response body.

| Class | HTTP | When | What to do |
|---|---|---|---|
| `AuthenticationError` | 401 | Key or token missing, wrong, revoked, expired, or for the other environment | Check the key; sign the user in again |
| `PermissionDeniedError` | 403 | Not allowed: a wrong or locked PIN, an unverified phone, an app that is suspended or pending | Read the message. For a wrong PIN, ask the user again; never retry on your own |
| `NotFoundError` | 404 | Does not exist, or belongs to another app | Check the id |
| `ValidationError` | 400, 422 | The request was refused as sent | Fix the fields named in `errors` |
| `RateLimitError` | 429 | Too many requests this minute | Wait `error.retry_after` seconds |
| `GatewayError` | 200 | The payment gateway refused, e.g. a wrong onboarding OTP | Show the message; let the user retry |
| `APIError` | 5xx | A fault on TukuPay's side | Retry later; contact TukuPay if it persists |
| `APIConnectionError` | none | No response: network failure or timeout | Retry; for a payment, reuse the same idempotency key |
| `WaitTimeoutError` | none | `wait` ran out of time | Check the transaction again later |

```python
from tukupay import RateLimitError, TukuPayError, ValidationError

try:
    user.payments.direct(payment_body)
except ValidationError as error:
    show_to_user(str(error))               # "amount: Input should be greater than 0"
except RateLimitError as error:
    retry_in(error.retry_after)
except TukuPayError as error:
    log(error.status, error.errors)
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

```python
tuku = TukuPay(
    os.environ["TUKUPAY_API_KEY"],
    timeout=30.0,
    max_retries=2,
    debug=True,
)
```

| Option | Default | Meaning |
|---|---|---|
| `api_key` | required | Your app's key (the first argument) |
| `base_url` | from the key | Override the server, e.g. `http://localhost:8000` for local development |
| `timeout` | `30.0` | Seconds allowed for each request |
| `max_retries` | `2` | Retries after the first attempt; `0` turns retrying off |
| `max_retry_delay` | `20.0` | A rate-limit wait longer than this many seconds is raised instead of waited out |
| `http_client` | a new one | Your own `httpx.Client`, for a proxy or for tests |
| `debug` | `False` | `True` logs each call's method, path and status to the `tukupay` logger at DEBUG level; or pass a function to receive the line. Keys, tokens, PINs and bodies are never logged |

The client holds a connection pool. Create it once and reuse it; call `tuku.close()` on shutdown, or use it as a context manager (`with TukuPay(...) as tuku:`).

## Reference

Every call returns the API's JSON as a `dict` or `list`. The client is synchronous and safe to share between threads; an async client is planned.

### `tuku.app`: the API key alone

| Call | Returns |
|---|---|
| `tuku.app.retrieve()` | The app this key belongs to: `id`, `name`, `status`, `app_type`, `key_type`, `environment` |
| `tuku.app.wallets.list(limit=, offset=)` | List of the app's wallets |
| `tuku.app.wallets.get(wallet_id)` | One wallet |
| `tuku.app.wallets.iterate(page_size=100)` | Iterator over every wallet |
| `tuku.app.transactions.list(**filters)` | `{transactions, total, size, page, has_more}` |
| `tuku.app.transactions.get(transaction_id)` | One transaction; never cached |
| `tuku.app.transactions.wait(transaction_id, timeout=120, interval=3)` | The transaction once it is `completed` or `failed` |
| `tuku.app.transactions.iterate(page_size=100, **filters)` | Iterator over every matching transaction |
| `tuku.app.users.list(limit=, offset=)` | `{app_id, users, total, size, page, has_more}` |
| `tuku.app.users.iterate(page_size=100)` | Iterator over every user |
| `tuku.app.sms.send(phone_numbers=, message=, sender_id=None)` | `{success, message, message_id, recipient_count, queued_at}` |
| `tuku.app.sms.outbox(limit=, offset=)` | List of sent messages, newest first |
| `tuku.app.sms.status(sms_id)` | One message from the outbox |

### `tuku.auth`: the API key alone

| Call | Returns |
|---|---|
| `tuku.auth.register(phone_number=, password=, accepted_terms=)` | `{message}`; the user is texted an OTP |
| `tuku.auth.verify_phone(phone_number=, otp_code=)` | `{message}` |
| `tuku.auth.send_phone_verification(phone_number)` | `{message}`; sends the OTP again |
| `tuku.auth.login(phone_number=, password=)` | `{access_token, refresh_token, token_type}` |
| `tuku.auth.refresh(refresh_token)` | A new token pair. Normally the library does this for you |
| `tuku.as_user(tokens, on_token_refresh=)` | A client that acts as that user. Also accepts `access_token=` and `refresh_token=` |

### As a user: key and token

Obtained from `tuku.as_user(tokens)`.

| Call | Returns |
|---|---|
| `user.tokens` | The user's current `{access_token, refresh_token}` |
| `user.account.me()` | The user's profile |
| `user.account.setup_pin(pin=, confirm_pin=)` | `{message}` |
| `user.account.verify_pin(pin)` | `{message}`; raises if the PIN is wrong |
| `user.account.logout()` | `{message}`; the tokens stop working |
| `user.onboarding.initial(**details)` | The gateway's reply; the user is texted an OTP |
| `user.onboarding.confirm(otp=, request_id=None)` | The gateway's reply; the wallet now exists |
| `user.onboarding.kyc(files=, data=None)` | The gateway's reply |
| `user.onboarding.status()` | `{status, wallet_count, ...}`; see the status table in step 3 |
| `user.kyc.upload(files=, data=)` | `{document, analysis, message}`. `data={"doc_type": ...}`, `files={"file": ...}` |
| `user.kyc.list()` | List of the user's KYC documents |
| `user.kyc.get(document_id)` | One KYC document |
| `user.wallets.list()` | List of the user's wallets |
| `user.wallets.get(wallet_id)` | One wallet |
| `user.wallets.create(**wallet)` | A further wallet for a user who already has one |
| `user.payments.methods(include_unavailable=None)` | The payment methods currently enabled |
| `user.payments.transaction_types()` | The transaction types and their fields |
| `user.payments.validate(payment)` | Fees, limits and balance check; no money moves |
| `user.payments.request_otp(amount=, transaction_type=, source_wallet_id=None)` | `{message, payment_hash, expires_in}` |
| `user.payments.direct(payment, idempotency_key=None)` | `{status, message, transaction_id, transaction_type, amount, payment_method, type_result, ...}` |
| `user.payments.bulk_transfer(transfer, idempotency_key=None)` | `{status, transaction_id, total_recipients, successful_transfers, failed_transfers, transfer_results, ...}` |
| `user.transactions.list(**filters)` | `{transactions, total, size, page, has_more}` |
| `user.transactions.get(transaction_id)` | One transaction; never cached |
| `user.transactions.wait(transaction_id, timeout=120, interval=3)` | The transaction once it is `completed` or `failed` |
| `user.transactions.iterate(page_size=100, **filters)` | Iterator over every matching transaction |
| `user.sms.send(phone_numbers=, message=, sender_id=None)` | Queues an SMS on the user's own credits |
| `user.sms.outbox(**filters)` | `{sms_records, total, size, page, has_more}` |
| `user.sms.balance()` | `{sms_balance, total_spent, total_earned, ...}` |

### Helpers

| Call | Returns |
|---|---|
| `failure_of(transaction)` | The failure details of a failed transaction, or `None` |
| `tukupay.__version__` | The library version |

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
