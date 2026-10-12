"""App-level endpoints (``/sdk/*``): the only ones that work with the API key
alone. They cover the app as a whole and are read-only, apart from SMS."""
from __future__ import annotations

from typing import Any, Dict, Iterator, List, Optional

from ._helpers import pages, wait_for_transaction
from ._transport import Transport


class AppResource:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self.wallets = AppWallets(transport)
        self.transactions = AppTransactions(transport)
        self.users = AppUsers(transport)
        self.sms = AppSms(transport)

    def retrieve(self) -> Dict[str, Any]:
        """The app this key belongs to. Also the quickest check that a key works."""
        return self._transport.request("GET", "/sdk/app/")


class AppWallets:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(self, *, limit: Optional[int] = None, offset: Optional[int] = None) -> List[Dict[str, Any]]:
        """Wallets that belong to this app."""
        return self._transport.request("GET", "/sdk/wallets/", query={"limit": limit, "offset": offset})

    def get(self, wallet_id: int) -> Dict[str, Any]:
        """One of the app's wallets. Another app's wallet raises ``NotFoundError``."""
        return self._transport.request("GET", f"/sdk/wallets/{wallet_id}")

    def iterate(self, page_size: int = 100) -> Iterator[Dict[str, Any]]:
        def fetch(limit: int, offset: int):
            items = self.list(limit=limit, offset=offset)
            return items, len(items) == limit

        return pages(fetch, page_size)


class AppTransactions:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(
        self,
        *,
        transaction_type: Optional[str] = None,
        status: Optional[str] = None,
        wallet_id: Optional[int] = None,
        start_date: Any = None,
        end_date: Any = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Transactions made through this app, newest first."""
        return self._transport.request(
            "GET",
            "/sdk/transactions/",
            query={
                "transaction_type": transaction_type,
                "status": status,
                "wallet_id": wallet_id,
                "start_date": start_date,
                "end_date": end_date,
                "limit": limit,
                "offset": offset,
            },
        )

    def get(self, transaction_id: int) -> Dict[str, Any]:
        """One of the app's transactions. Never cached, so safe to poll."""
        return self._transport.request("GET", f"/sdk/transactions/{transaction_id}")

    def wait(self, transaction_id: int, *, timeout: float = 120.0, interval: float = 3.0) -> Dict[str, Any]:
        """Polls until the transaction is ``completed`` or ``failed``."""
        return wait_for_transaction(lambda: self.get(transaction_id), timeout, interval)

    def iterate(self, page_size: int = 100, **filters: Any) -> Iterator[Dict[str, Any]]:
        def fetch(limit: int, offset: int):
            result = self.list(limit=limit, offset=offset, **filters)
            return result["transactions"], result["has_more"]

        return pages(fetch, page_size)


class AppUsers:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def list(self, *, limit: Optional[int] = None, offset: Optional[int] = None) -> Dict[str, Any]:
        """Users registered under this app."""
        return self._transport.request("GET", "/sdk/users/", query={"limit": limit, "offset": offset})

    def iterate(self, page_size: int = 100) -> Iterator[Dict[str, Any]]:
        def fetch(limit: int, offset: int):
            result = self.list(limit=limit, offset=offset)
            return result["users"], result["has_more"]

        return pages(fetch, page_size)


class AppSms:
    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def send(self, *, phone_numbers: List[str], message: str, sender_id: Optional[str] = None) -> Dict[str, Any]:
        """Queues an SMS on the app owner's account, using the owner's SMS credits.

        The returned ``message_id`` identifies the queued batch; it cannot be used
        with ``status``. Read ``outbox`` to find the delivered messages.
        """
        body: Dict[str, Any] = {"phone_numbers": phone_numbers, "message": message}
        if sender_id is not None:
            body["sender_id"] = sender_id
        return self._transport.request("POST", "/sdk/sms/send", json=body)

    def outbox(self, *, limit: Optional[int] = None, offset: Optional[int] = None) -> List[Dict[str, Any]]:
        """Messages sent on the app owner's account, newest first."""
        return self._transport.request("GET", "/sdk/sms/outbox", query={"limit": limit, "offset": offset})

    def status(self, sms_id: int) -> Dict[str, Any]:
        """One message from the outbox, by its outbox ``id``."""
        return self._transport.request("GET", f"/sdk/sms/status/{sms_id}")
