# Changelog

## 0.1.0b1

First release.

- `TukuPay` client: API key in `X-API-Key`, base URL chosen from the key prefix.
- `tuku.app`: your app's wallets, transactions, users and SMS, with the API key alone.
- `tuku.auth`: register, verify phone, login, refresh.
- `tuku.as_user(tokens)`: account, onboarding, KYC, wallets, payments, transactions and SMS as a signed-in user, with automatic token renewal.
- `transactions.wait()` to learn a payment's outcome, and `failure_of()` to read why one failed.
- Typed errors, retries with backoff, idempotency keys on payments.
- Synchronous only. An async client is planned.
- A wrong PIN (HTTP 401) is never mistaken for an expired token and repeated.
