from __future__ import annotations

import time
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from .errors import GatewayError, WaitTimeoutError, message_from_body


def wait_for_transaction(
    read: Callable[[], Dict[str, Any]],
    timeout: float = 120.0,
    interval: float = 3.0,
) -> Dict[str, Any]:
    """Reads a transaction until it leaves ``pending``.

    A 200 from a payment endpoint means the payment was requested, not that money
    moved. This is how the outcome is learned. It returns for ``completed`` and
    for ``failed`` alike, so check ``status`` on the result.
    """
    deadline = time.monotonic() + timeout
    while True:
        transaction = read()
        if transaction.get("status") != "pending":
            return transaction
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise WaitTimeoutError(
                f"Transaction {transaction.get('id')} was still pending after {timeout:g} s", transaction
            )
        time.sleep(min(interval, remaining))


def failure_of(transaction: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The decoded failure block of a failed transaction, if it has one.

    ``gateway_code`` is the useful field; ``code`` is nearly always the generic
    ``SP01002``.
    """
    metadata = transaction.get("transaction_metadata")
    failure = metadata.get("failure") if isinstance(metadata, dict) else None
    return failure if isinstance(failure, dict) else None


def pages(
    fetch_page: Callable[[int, int], Tuple[List[Dict[str, Any]], bool]],
    page_size: int = 100,
) -> Iterator[Dict[str, Any]]:
    """Walks a limit/offset list page by page."""
    offset = 0
    while True:
        items, has_more = fetch_page(page_size, offset)
        yield from items
        if not has_more or not items:
            return
        offset += page_size


def raise_if_refused(body: Any) -> Any:
    # Some gateway calls answer a refusal with HTTP 200 and {"status": false}.
    if isinstance(body, dict) and body.get("status") is False:
        raise GatewayError(
            message_from_body(body, "The payment gateway refused the request"), status=200, body=body
        )
    return body
