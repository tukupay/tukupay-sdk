# TukuPay SDKs

Official client libraries for the [TukuPay](https://tuku.money) API: register users, give them wallets, collect and send money over M-Pesa, and send SMS, from your own server.

| Language | Package | Guide |
|---|---|---|
| Node.js / TypeScript | [`@tukupay/sdk`](https://www.npmjs.com/package/@tukupay/sdk) | [node/README.md](node/README.md) |
| Python | [`tukupay`](https://pypi.org/project/tukupay/) | [python/README.md](python/README.md) |
| PHP | [`tukupay/tukupay-php`](https://packagist.org/packages/tukupay/tukupay-php) | [tukupay-php](https://github.com/tukupay/tukupay-php#readme) |

Each guide walks through a complete integration, from registering a user to a completed payment.

## Install

```bash
npm install @tukupay/sdk@beta                    # Node.js / TypeScript
pip install --pre tukupay                        # Python
composer require tukupay/tukupay-php:^0.1@beta   # PHP
```

These are **server-side** libraries. They use your app's API key, which must never be put in a web page or mobile app.

> **The test environment is not a sandbox.** A payout made with a test key moves real money. Only pay numbers you control.

## Support

Report problems in this repository's issues. Never include an API key, token or PIN.

## License

MIT
