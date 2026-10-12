"""Errors raised by the library.

Every failure the API reports arrives as ``{"errors": ...}``; that value is kept
untouched on ``errors``.
"""
from __future__ import annotations

import json
from typing import Any, Mapping, Optional


class TukuPayError(Exception):
    """Base class. ``status`` is the HTTP status, or None when there was no response."""

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        errors: Any = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        #: The API's ``errors`` value: a string, a list of field errors, or a dict.
        self.errors = errors
        #: The whole response body, as parsed.
        self.body = body


class AuthenticationError(TukuPayError):
    """401: the API key or the user's token was missing, wrong, revoked or expired."""


class PermissionDeniedError(TukuPayError):
    """403: the credentials are valid but not allowed to do this."""


class NotFoundError(TukuPayError):
    """404: not found, or it belongs to another app. The API does not say which."""


class ValidationError(TukuPayError):
    """400 or 422: the request was refused as sent."""


class RateLimitError(TukuPayError):
    """429: the key's per-minute limit was passed."""

    def __init__(self, message: str, *, retry_after: Optional[float] = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        #: Seconds until the limit resets, from ``Retry-After``.
        self.retry_after = retry_after


class GatewayError(TukuPayError):
    """The payment gateway refused the request although the API answered HTTP 200,
    for example a wrong OTP on onboarding confirm (``{"status": false, ...}``)."""


class APIError(TukuPayError):
    """5xx: something failed on TukuPay's side."""


class APIConnectionError(TukuPayError):
    """No response: DNS, TLS, a dropped connection or a timeout."""


class WaitTimeoutError(TukuPayError):
    """``transactions.wait`` gave up before the transaction left ``pending``."""

    def __init__(self, message: str, transaction: Any) -> None:
        super().__init__(message)
        #: The transaction as last read, still pending.
        self.transaction = transaction


def _describe(errors: Any) -> Optional[str]:
    if isinstance(errors, str):
        return errors
    if isinstance(errors, list):
        parts = []
        for item in errors:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get("message") or item.get("msg") or item.get("detail")
                field = item.get("field")
                if field is None and isinstance(item.get("loc"), list):
                    field = ".".join(str(part) for part in item["loc"])
                if isinstance(text, str):
                    parts.append(f"{field}: {text}" if field else text)
                    continue
            parts.append(json.dumps(item))
        return "; ".join(parts)
    if isinstance(errors, dict):
        text = errors.get("message") or errors.get("detail")
        return text if isinstance(text, str) else json.dumps(errors)
    return None


def message_from_body(body: Any, fallback: str) -> str:
    """Pulls the human-readable text out of a response body."""
    if isinstance(body, dict):
        for key in ("errors", "detail", "message"):
            text = _describe(body.get(key))
            if text:
                return text
        return fallback
    if isinstance(body, str) and body.strip():
        return body.strip()[:300]
    return fallback


def error_from_response(status: int, body: Any, headers: Mapping[str, str]) -> TukuPayError:
    errors = body.get("errors") if isinstance(body, dict) else None
    message = message_from_body(body, f"Request failed with HTTP {status}")
    kwargs = {"status": status, "errors": errors, "body": body}

    if status == 401:
        return AuthenticationError(message, **kwargs)
    if status == 403:
        return PermissionDeniedError(message, **kwargs)
    if status == 404:
        return NotFoundError(message, **kwargs)
    if status in (400, 422):
        return ValidationError(message, **kwargs)
    if status == 429:
        try:
            retry_after: Optional[float] = float(headers.get("retry-after", ""))
        except ValueError:
            retry_after = None
        return RateLimitError(message, retry_after=retry_after if retry_after and retry_after > 0 else None, **kwargs)
    if status >= 500:
        return APIError(message, **kwargs)
    return TukuPayError(message, **kwargs)
