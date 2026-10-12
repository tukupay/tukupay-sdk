"""Everything done as one signed-in user. Each call carries the app's key and the
user's token, and behaves exactly as it does from TukuPay's own app."""
from __future__ import annotations

import uuid
from typing import Any, Dict, Iterator, List, Mapping, Optional

from ._helpers import pages, raise_if_refused, wait_for_transaction
from ._transport import TokenSource, Transport


class _Calls:
    def __init__(self, transport: Transport, tokens: TokenSource) -> None:
        self._transport = transport
        self._tokens = tokens

    def _call(self, method: str, path: str, **kwargs: Any) -> Any:
        return self._transport.request(method, path, tokens=self._tokens, **kwargs)


class UserClient(_Calls):
    def __init__(self, transport: Transport, tokens: TokenSource) -> None:
        super().__init__(transport, tokens)
        self.account = UserAccount(transport, tokens)
        self.onboarding = UserOnboarding(transport, tokens)
        self.kyc = UserKyc(transport, tokens)
        self.wallets = UserWallets(transport, tokens)
        self.payments = UserPayments(transport, tokens)
        self.transactions = UserTransactions(transport, tokens)
        self.sms = UserSms(transport, tokens)

    @property
    def tokens(self) -> Dict[str, Optional[str]]:
        """The user's current tokens, to store between requests."""
        return {"access_token": self._tokens.access_token, "refresh_token": self._tokens.refresh_token}


class UserAccount(_Calls):
    def me(self) -> Dict[str, Any]:
        return self._call("GET", "/sdk/user/me")

    def setup_pin(self, *, pin: str, confirm_pin: str) -> Dict[str, Any]:
        """Sets the user's payment PIN. Required before any wallet debit."""
        return self._call("POST", "/sdk/user/setup-pin", json={"pin": pin, "confirm_pin": confirm_pin})

    def verify_pin(self, pin: str) -> Dict[str, Any]:
        return self._call("POST", "/sdk/user/verify-pin", json={"pin": pin})

    def logout(self) -> Dict[str, Any]:
        """Ends the session. The tokens stop working."""
        return self._call("POST", "/sdk/auth/logout")


class UserOnboarding(_Calls):
    def initial(self, **details: Any) -> Dict[str, Any]:
        """Step 1: starts wallet onboarding. The user receives an OTP by SMS."""
        return raise_if_refused(self._call("POST", "/sdk/user/onboarding/initial", json=details))

    def confirm(self, *, otp: str, request_id: Optional[str] = None) -> Dict[str, Any]:
        """Step 2: confirms with the OTP. A wrong OTP raises ``GatewayError``."""
        body: Dict[str, Any] = {"otp": otp}
        if request_id is not None:
            body["request_id"] = request_id
        return raise_if_refused(self._call("POST", "/sdk/user/onboarding/confirm", json=body))

    def kyc(self, *, files: Any, data: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """Step 3: uploads the identity documents, as multipart form data."""
        return raise_if_refused(self._call("POST", "/sdk/user/onboarding/kyc", files=files, data=data))

    def status(self) -> Dict[str, Any]:
        """How far the user is through wallet onboarding and identity checks."""
        return self._call("GET", "/sdk/user/onboarding/status")


class UserKyc(_Calls):
    def upload(self, *, files: Any, data: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """Uploads one KYC document, as multipart form data."""
        return self._call("POST", "/sdk/user/kyc/", files=files, data=data)

    def list(self) -> List[Dict[str, Any]]:
        return self._call("GET", "/sdk/user/kyc/")

    def get(self, document_id: int) -> Dict[str, Any]:
        return self._call("GET", f"/sdk/user/kyc/{document_id}")


class UserWallets(_Calls):
    def list(self) -> List[Dict[str, Any]]:
        return self._call("GET", "/sdk/user/wallets/")

    def get(self, wallet_id: int) -> Dict[str, Any]:
        return self._call("GET", f"/sdk/user/wallets/{wallet_id}")

    def create(self, **wallet: Any) -> Dict[str, Any]:
        """Adds another wallet for a user who already has one."""
        return self._call("POST", "/sdk/user/wallets/", json=wallet)


class UserPayments(_Calls):
    def methods(self, *, include_unavailable: Optional[bool] = None) -> Dict[str, Any]:
        """Payment methods currently enabled."""
        return self._call("GET", "/sdk/user/payments/payment-methods", query={"include_unavailable": include_unavailable})

    def transaction_types(self) -> Dict[str, Any]:
        return self._call("GET", "/sdk/user/payments/transaction-types")

    def validate(self, payment: Mapping[str, Any]) -> Dict[str, Any]:
        """Checks a payment without making it: fees, limits and balance."""
        return self._call("POST", "/sdk/user/payments/validate", json=dict(payment))

    def request_otp(
        self, *, amount: float, transaction_type: str, source_wallet_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """Sends the user the OTP that some payments need in addition to the PIN."""
        body: Dict[str, Any] = {"amount": amount, "transaction_type": transaction_type}
        if source_wallet_id is not None:
            body["source_wallet_id"] = source_wallet_id
        return self._call("POST", "/sdk/user/payments/request-otp", json=body)

    def direct(self, payment: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Makes a payment.

        Success here means the payment was *requested*: follow with
        ``transactions.wait(result["transaction_id"])`` for the outcome, and show
        the payer any ``customer_message`` in the response word for word.

        ``idempotency_key`` identifies this payment so a repeat is recognised and
        not paid twice. One is generated when left out; pass your own (your order
        id, say) to make a retry from your side safe too.
        """
        return self._call(
            "POST", "/sdk/user/payments/direct", json=dict(payment), idempotency_key=idempotency_key or str(uuid.uuid4())
        )

    def bulk_transfer(self, transfer: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Pays several recipients from one wallet."""
        return self._call(
            "POST",
            "/sdk/user/payments/bulk-transfer",
            json=dict(transfer),
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )


class UserTransactions(_Calls):
    def list(self, **filters: Any) -> Dict[str, Any]:
        """The user's transactions. Filters: ``transaction_id``, ``transaction_type``,
        ``status``, ``start_date``, ``end_date``, ``min_amount``, ``max_amount``,
        ``wallet_id``, ``search``, ``limit``, ``offset``."""
        return self._call("GET", "/sdk/user/transactions/", query=filters)

    def get(self, transaction_id: int) -> Dict[str, Any]:
        """One transaction. Never cached, so safe to poll."""
        return self._call("GET", f"/sdk/user/transactions/{transaction_id}")

    def wait(self, transaction_id: int, *, timeout: float = 120.0, interval: float = 3.0) -> Dict[str, Any]:
        """Polls until the transaction is ``completed`` or ``failed``."""
        return wait_for_transaction(lambda: self.get(transaction_id), timeout, interval)

    def iterate(self, page_size: int = 100, **filters: Any) -> Iterator[Dict[str, Any]]:
        def fetch(limit: int, offset: int):
            result = self.list(limit=limit, offset=offset, **filters)
            return result["transactions"], result["has_more"]

        return pages(fetch, page_size)


class UserSms(_Calls):
    def send(self, *, phone_numbers: List[str], message: str, sender_id: Optional[str] = None) -> Dict[str, Any]:
        """Queues an SMS on this user's account and credits."""
        body: Dict[str, Any] = {"phone_numbers": phone_numbers, "message": message}
        if sender_id is not None:
            body["sender_id"] = sender_id
        return self._call("POST", "/sdk/user/sms/send", json=body)

    def outbox(self, **filters: Any) -> Dict[str, Any]:
        """Filters: ``status``, ``phone_number``, ``search``, ``limit``, ``offset``."""
        return self._call("GET", "/sdk/user/sms/outbox", query=filters)

    def balance(self) -> Dict[str, Any]:
        """The user's SMS credit balance."""
        return self._call("GET", "/sdk/user/sms/balance")
