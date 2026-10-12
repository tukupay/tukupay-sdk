from __future__ import annotations

import random
import re
import threading
import time
from datetime import date, datetime
from typing import Any, Callable, Dict, Mapping, Optional

import httpx

from ._version import __version__
from .errors import APIConnectionError, RateLimitError, error_from_response, message_from_body

API_PREFIX = "/api/v1"
RETRYABLE_STATUSES = frozenset({502, 503, 504})
# The API's wording for a missing, expired, revoked or malformed access token.
_TOKEN_MESSAGE = re.compile(r"authentication credentials|token|not authenticated|authentication required", re.IGNORECASE)
_NOT_A_TOKEN_MESSAGE = re.compile(r"api key|refresh token|\bpin\b", re.IGNORECASE)


def _is_token_problem(message: str) -> bool:
    return message == "" or bool(_TOKEN_MESSAGE.search(message) and not _NOT_A_TOKEN_MESSAGE.search(message))


def _backoff(attempt: int) -> float:
    # Exponential backoff with jitter: 0.5s, 1s, 2s ... each scaled by 0.5-1.
    return 0.5 * (2**attempt) * (0.5 + random.random() / 2)


def _clean_query(query: Optional[Mapping[str, Any]]) -> Dict[str, str]:
    cleaned: Dict[str, str] = {}
    for name, value in (query or {}).items():
        if value is None:
            continue
        if isinstance(value, bool):
            cleaned[name] = "true" if value else "false"
        elif isinstance(value, (datetime, date)):
            cleaned[name] = value.isoformat()
        else:
            cleaned[name] = str(value)
    return cleaned


class TokenSource:
    """A user's tokens, and how to renew them. Shared by every call made as that user."""

    def __init__(
        self,
        access_token: str,
        refresh_token: Optional[str],
        refresh: Callable[[str], Dict[str, Any]],
        on_token_refresh: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.access_token = access_token
        self.refresh_token = refresh_token
        self._refresh = refresh
        self._on_token_refresh = on_token_refresh
        self._lock = threading.Lock()

    def renew(self, rejected_access_token: str) -> None:
        # One renewal at a time: the API revokes a refresh token on use, so two
        # threads renewing in parallel would leave one holding a dead token.
        with self._lock:
            if self.access_token != rejected_access_token:
                return  # another thread already renewed
            tokens = self._refresh(self.refresh_token or "")
            self.access_token = tokens["access_token"]
            self.refresh_token = tokens.get("refresh_token")
            if self._on_token_refresh:
                self._on_token_refresh(tokens)


class Transport:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        timeout: float,
        max_retries: int,
        max_retry_delay: float,
        http_client: Optional[httpx.Client] = None,
        debug: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._max_retry_delay = max_retry_delay
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client()
        self._debug = debug

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        json: Any = None,
        data: Optional[Mapping[str, Any]] = None,
        files: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        tokens: Optional[TokenSource] = None,
    ) -> Any:
        verb = method.upper()
        url = self._base_url + API_PREFIX + (path if path.startswith("/") else "/" + path)
        # A POST is only safe to send twice when the endpoint will recognise the repeat.
        repeatable = verb in ("GET", "HEAD") or bool(idempotency_key)

        attempt = 0
        refreshed = False

        while True:
            send_headers = {
                "Accept": "application/json",
                "User-Agent": f"tukupay-python/{__version__}",
                **(headers or {}),
                "X-API-Key": self._api_key,
            }
            access_token = tokens.access_token if tokens else None
            if access_token and "Authorization" not in send_headers:
                send_headers["Authorization"] = f"Bearer {access_token}"
            if idempotency_key:
                send_headers["Idempotency-Key"] = idempotency_key

            try:
                response = self._http.request(
                    verb,
                    url,
                    params=_clean_query(query),
                    json=json,
                    data=data,
                    files=files,
                    headers=send_headers,
                    timeout=timeout if timeout is not None else self._timeout,
                )
            except httpx.TransportError as cause:
                if repeatable and attempt < self._max_retries:
                    time.sleep(_backoff(attempt))
                    attempt += 1
                    continue
                timed_out = isinstance(cause, httpx.TimeoutException)
                raise APIConnectionError(
                    f"Request to {verb} {path} timed out" if timed_out else f"Could not reach TukuPay for {verb} {path}"
                ) from cause

            if self._debug:
                self._debug(f"{verb} {path} -> {response.status_code}")
            body = _parse_body(response)
            if response.is_success:
                return body

            # An expired access token is renewed once. Other things also answer 401
            # and must not be repeated: a rejected API key, and above all a wrong PIN,
            # where a silent second try would cost the user another attempt before lockout.
            if (
                response.status_code == 401
                and tokens is not None
                and tokens.refresh_token
                and not refreshed
                and _is_token_problem(message_from_body(body, ""))
            ):
                refreshed = True
                tokens.renew(access_token or "")
                continue

            error = error_from_response(response.status_code, body, response.headers)
            retryable = response.status_code == 429 or (repeatable and response.status_code in RETRYABLE_STATUSES)
            if retryable and attempt < self._max_retries:
                wait = (
                    error.retry_after
                    if isinstance(error, RateLimitError) and error.retry_after is not None
                    else _backoff(attempt)
                )
                if wait <= self._max_retry_delay:
                    attempt += 1
                    time.sleep(wait)
                    continue
            raise error


def _parse_body(response: httpx.Response) -> Any:
    if response.status_code == 204 or not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text
