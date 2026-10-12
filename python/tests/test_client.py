import json
from datetime import datetime

import httpx
import pytest

import tukupay
from tukupay import (
    APIConnectionError,
    APIError,
    AuthenticationError,
    GatewayError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    TukuPay,
    ValidationError,
    WaitTimeoutError,
    failure_of,
)

from conftest import Mock

FRESH = {"access_token": "new", "refresh_token": "new-refresh", "token_type": "bearer"}


# construction

@pytest.mark.parametrize(
    "api_key,host", [("sk_test_x", "test.api.tuku.money"), ("sk_live_x", "api.tuku.money")]
)
def test_base_url_follows_the_key_prefix(api_key, host):
    mock = Mock((200, {}))
    mock.client(api_key=api_key).app.retrieve()
    assert mock.calls[0].url.host == host
    assert mock.calls[0].url.path == "/api/v1/sdk/app/"


def test_refuses_a_missing_or_unrecognised_key():
    with pytest.raises(ValueError):
        TukuPay("")
    with pytest.raises(ValueError, match="sk_test_ or sk_live_"):
        TukuPay("legacy-key")
    TukuPay("legacy-key", base_url="http://localhost:8000/").close()


# requests

def test_app_calls_send_the_key_and_no_user_token():
    mock = Mock((200, []))
    mock.client().app.wallets.list(limit=5, offset=10)
    request = mock.calls[0]
    assert request.headers["x-api-key"] == "sk_test_abc"
    assert request.headers["user-agent"] == f"tukupay-python/{tukupay.__version__}"
    assert "authorization" not in request.headers
    assert request.url.query == b"limit=5&offset=10"


def test_empty_filters_are_left_out_and_dates_serialised():
    mock = Mock((200, {"transactions": [], "has_more": False}))
    mock.client().app.transactions.list(status="completed", wallet_id=None, start_date=datetime(2026, 10, 1))
    assert dict(mock.calls[0].url.params) == {"status": "completed", "start_date": "2026-10-01T00:00:00"}


def test_user_calls_send_key_and_token():
    mock = Mock((200, []))
    mock.client().as_user(access_token="tok").wallets.list()
    assert mock.calls[0].headers["x-api-key"] == "sk_test_abc"
    assert mock.calls[0].headers["authorization"] == "Bearer tok"
    assert mock.paths == ["/api/v1/sdk/user/wallets/"]


def test_files_are_sent_as_multipart():
    mock = Mock((200, {"id": 1}))
    mock.client().as_user(access_token="tok").kyc.upload(
        files={"file": ("id.png", b"abc", "image/png")}, data={"doc_type": "national_id"}
    )
    assert mock.calls[0].headers["content-type"].startswith("multipart/form-data")


# errors

@pytest.mark.parametrize(
    "status,error_type",
    [
        (401, AuthenticationError),
        (403, PermissionDeniedError),
        (404, NotFoundError),
        (400, ValidationError),
        (422, ValidationError),
        (500, APIError),
    ],
)
def test_status_maps_to_error(status, error_type):
    mock = Mock((status, {"errors": "Nope"}))
    with pytest.raises(error_type) as caught:
        mock.client(max_retries=0).app.retrieve()
    assert caught.value.status == status
    assert str(caught.value) == "Nope"
    assert caught.value.errors == "Nope"


def test_field_errors_become_one_message_and_are_kept():
    errors = [{"field": "phone_number", "message": "Invalid phone"}, {"message": "Bad"}]
    mock = Mock((422, {"errors": errors}))
    with pytest.raises(ValidationError) as caught:
        mock.client().auth.login(phone_number="x", password="y")
    assert str(caught.value) == "phone_number: Invalid phone; Bad"
    assert caught.value.errors == errors


def test_network_failure_is_wrapped():
    mock = Mock(httpx.ConnectError("boom"))
    with pytest.raises(APIConnectionError) as caught:
        mock.client(max_retries=0).app.retrieve()
    assert caught.value.status is None


def test_200_with_status_false_raises_gateway_error():
    mock = Mock((200, {"status": False, "message": "Invalid OTP"}))
    with pytest.raises(GatewayError, match="Invalid OTP"):
        mock.client().as_user(access_token="tok").onboarding.confirm(otp="000000")


# retries

def test_get_is_retried_on_503_and_dropped_connection():
    mock = Mock((503, None), httpx.ConnectError("boom"), (200, {"id": 1}))
    assert mock.client().app.retrieve() == {"id": 1}
    assert len(mock.calls) == 3


def test_gives_up_after_max_retries():
    mock = Mock((503, None), (503, None), (503, None))
    with pytest.raises(APIError):
        mock.client().app.retrieve()
    assert len(mock.calls) == 3


def test_post_without_idempotency_key_is_never_repeated():
    mock = Mock((503, None))
    with pytest.raises(APIError):
        mock.client().app.sms.send(phone_numbers=["0700000000"], message="hi")
    assert len(mock.calls) == 1


def test_payment_is_repeated_with_the_same_idempotency_key():
    mock = Mock(httpx.ConnectError("boom"), (200, {"transaction_id": 9}))
    mock.client().as_user(access_token="tok").payments.direct({"pin": "1234"})
    first, second = (call.headers["idempotency-key"] for call in mock.calls)
    assert len(first) == 36 and first == second


def test_callers_idempotency_key_is_used():
    mock = Mock((200, {}))
    mock.client().as_user(access_token="tok").payments.direct({}, idempotency_key="order-42")
    assert mock.calls[0].headers["idempotency-key"] == "order-42"


def test_short_rate_limit_is_waited_out_and_long_one_raised(no_sleep):
    mock = Mock((429, {"errors": "Rate limit"}, {"Retry-After": "2"}), (200, {"id": 1}))
    assert mock.client().app.retrieve() == {"id": 1}
    assert no_sleep == [2.0]

    mock = Mock((429, {"errors": "Rate limit"}, {"Retry-After": "45"}))
    with pytest.raises(RateLimitError) as caught:
        mock.client().app.retrieve()
    assert caught.value.retry_after == 45
    assert len(mock.calls) == 1


# token refresh

def test_expired_token_is_renewed_once_and_reported():
    mock = Mock((401, {"errors": "Token expired"}), (200, FRESH), (200, {"id": 7}))
    seen = []
    user = mock.client().as_user(
        {"access_token": "old", "refresh_token": "old-refresh"}, on_token_refresh=seen.append
    )
    assert user.account.me() == {"id": 7}
    assert mock.paths == ["/api/v1/sdk/user/me", "/api/v1/sdk/auth/refresh", "/api/v1/sdk/user/me"]
    assert mock.calls[1].headers["authorization"] == "Bearer old-refresh"
    assert mock.calls[2].headers["authorization"] == "Bearer new"
    assert seen == [FRESH]
    assert user.tokens == {"access_token": "new", "refresh_token": "new-refresh"}


def test_no_loop_when_the_renewed_token_is_refused_too():
    mock = Mock((401, None), (200, FRESH), (401, None))
    with pytest.raises(AuthenticationError):
        mock.client().as_user(access_token="old", refresh_token="r").account.me()
    assert len(mock.calls) == 3


def test_refresh_token_is_not_spent_on_a_rejected_api_key():
    mock = Mock((401, {"errors": "Invalid or revoked API key"}))
    with pytest.raises(AuthenticationError):
        mock.client().as_user(access_token="old", refresh_token="r").account.me()
    assert len(mock.calls) == 1


def test_raises_straight_away_without_a_refresh_token():
    mock = Mock((401, None))
    with pytest.raises(AuthenticationError):
        mock.client().as_user(access_token="old").account.me()
    assert len(mock.calls) == 1


# transactions

def test_wait_polls_until_settled():
    mock = Mock(
        (200, {"id": 5, "status": "pending"}),
        (200, {"id": 5, "status": "pending"}),
        (200, {"id": 5, "status": "failed", "transaction_metadata": {"failure": {"gateway_code": "1032"}}}),
    )
    transaction = mock.client().app.transactions.wait(5, interval=0.1)
    assert len(mock.calls) == 3
    assert transaction["status"] == "failed"
    assert failure_of(transaction)["gateway_code"] == "1032"


def test_wait_gives_up_at_the_timeout():
    mock = Mock((200, {"id": 5, "status": "pending"}))
    with pytest.raises(WaitTimeoutError) as caught:
        mock.client().app.transactions.wait(5, timeout=0)
    assert caught.value.transaction == {"id": 5, "status": "pending"}


def test_iterate_walks_every_page():
    mock = Mock(
        (200, {"transactions": [{"id": 1}, {"id": 2}], "has_more": True}),
        (200, {"transactions": [{"id": 3}], "has_more": False}),
    )
    ids = [t["id"] for t in mock.client().app.transactions.iterate(page_size=2, status="completed")]
    assert ids == [1, 2, 3]
    assert dict(mock.calls[1].url.params) == {"status": "completed", "limit": "2", "offset": "2"}


def test_request_bodies_are_passed_through():
    mock = Mock((200, {}))
    mock.client().auth.register(phone_number="0712345678", password="pw", accepted_terms=True)
    assert json.loads(mock.calls[0].content) == {
        "phone_number": "0712345678",
        "password": "pw",
        "accepted_terms": True,
    }


def test_phone_verification_calls():
    mock = Mock((200, {"message": "ok"}), (200, {"message": "sent"}))
    tuku = mock.client()
    tuku.auth.verify_phone(phone_number="0712345678", otp_code="123456")
    tuku.auth.send_phone_verification("0712345678")
    assert mock.paths == ["/api/v1/sdk/auth/verify-phone", "/api/v1/sdk/auth/send-phone-verification"]
    assert json.loads(mock.calls[0].content) == {"phone_number": "0712345678", "otp_code": "123456"}
    assert json.loads(mock.calls[1].content) == {"phone_number": "0712345678"}


def test_a_wrong_pin_is_not_repeated():
    mock = Mock((401, {"errors": "Invalid PIN. 2 attempts remaining."}))
    with pytest.raises(AuthenticationError):
        mock.client().as_user(access_token="tok", refresh_token="r").account.verify_pin("0000")
    assert len(mock.calls) == 1
