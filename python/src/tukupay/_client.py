from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Mapping, Optional, Union

import httpx

from ._app import AppResource
from ._transport import TokenSource, Transport
from ._user import UserClient

BASE_URLS = {
    "sk_test_": "https://test.api.tuku.money",
    "sk_live_": "https://api.tuku.money",
}

logger = logging.getLogger("tukupay")


class AuthResource:
    """Registering and signing in. These need the API key but no user yet."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def register(self, *, phone_number: str, password: str, accepted_terms: bool, **extra: Any) -> Dict[str, Any]:
        """Registers a user under this key's app.

        Leave ``app_id`` out: the app comes from the key. The user receives an
        OTP by SMS; pass it to ``verify_phone()``.
        """
        body = {"phone_number": phone_number, "password": password, "accepted_terms": accepted_terms, **extra}
        return self._transport.request("POST", "/sdk/auth/register", json=body)

    def verify_phone(self, *, phone_number: str, otp_code: str) -> Dict[str, Any]:
        """Confirms a new user's phone with the OTP they received after registering.

        A user cannot sign in until this is done.
        """
        return self._transport.request(
            "POST", "/sdk/auth/verify-phone", json={"phone_number": phone_number, "otp_code": otp_code}
        )

    def send_phone_verification(self, phone_number: str) -> Dict[str, Any]:
        """Sends the phone verification OTP again, for a user who did not get it."""
        return self._transport.request(
            "POST", "/sdk/auth/send-phone-verification", json={"phone_number": phone_number}
        )

    def login(self, *, phone_number: str, password: str) -> Dict[str, Any]:
        """Signs a user in. Their phone must be verified. Pass the result to ``tuku.as_user()``."""
        return self._transport.request(
            "POST", "/sdk/auth/login", json={"phone_number": phone_number, "password": password}
        )

    def refresh(self, refresh_token: str) -> Dict[str, Any]:
        """Exchanges a refresh token for a new pair. The old refresh token stops working."""
        return self._transport.request(
            "POST", "/sdk/auth/refresh", headers={"Authorization": f"Bearer {refresh_token}"}
        )


class TukuPay:
    """The TukuPay client.

    :param api_key: The app's key, ``sk_test_...`` or ``sk_live_...``. Keep it on the server.
    :param base_url: Defaults to the environment the key belongs to.
    :param timeout: Per-request timeout in seconds.
    :param max_retries: Retries after the first attempt.
    :param max_retry_delay: A rate-limit wait longer than this many seconds is raised, not waited out.
    :param http_client: Your own ``httpx.Client``, for proxies or tests.
    :param debug: ``True`` logs method, path and status of each call to the ``tukupay``
        logger; a callable receives the line instead. Keys, tokens, PINs and bodies are never logged.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        max_retry_delay: float = 20.0,
        http_client: Optional[httpx.Client] = None,
        debug: Union[bool, Callable[[str], None]] = False,
    ) -> None:
        if not api_key:
            raise ValueError("TukuPay: api_key is required")
        if base_url is None:
            base_url = next((url for prefix, url in BASE_URLS.items() if api_key.startswith(prefix)), None)
        if not base_url:
            raise ValueError("TukuPay: api_key must start with sk_test_ or sk_live_, or pass base_url")

        self._transport = Transport(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            max_retry_delay=max_retry_delay,
            http_client=http_client,
            debug=logger.debug if debug is True else (debug or None),
        )
        #: App-level endpoints: the API key alone.
        self.app = AppResource(self._transport)
        #: Register and sign in users.
        self.auth = AuthResource(self._transport)

    def as_user(
        self,
        session: Optional[Mapping[str, Any]] = None,
        *,
        access_token: Optional[str] = None,
        refresh_token: Optional[str] = None,
        on_token_refresh: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> UserClient:
        """A client that acts as one signed-in user.

        Accepts the result of ``auth.login()``, or tokens stored earlier. With a
        refresh token present, an expired access token is renewed and the call
        repeated, once; ``on_token_refresh`` then receives the new pair to store.
        """
        if session is not None:
            access_token = access_token or session.get("access_token")
            refresh_token = refresh_token or session.get("refresh_token")
        if not access_token:
            raise ValueError("TukuPay.as_user: access_token is required")
        tokens = TokenSource(access_token, refresh_token, self.auth.refresh, on_token_refresh)
        return UserClient(self._transport, tokens)

    def close(self) -> None:
        self._transport.close()

    def __enter__(self) -> "TukuPay":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
