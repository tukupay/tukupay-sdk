import json

import httpx
import pytest

from tukupay import TukuPay


class Mock:
    """Replays queued replies and records what was sent."""

    def __init__(self, *replies):
        self.queue = list(replies)
        self.calls = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if not self.queue:
            raise AssertionError("no reply queued")
        reply = self.queue.pop(0)
        if isinstance(reply, Exception):
            raise reply
        status, body, *rest = reply
        headers = rest[0] if rest else {}
        content = b"" if body is None else json.dumps(body).encode()
        return httpx.Response(status, content=content, headers=headers)

    def client(self, **options) -> TukuPay:
        http = httpx.Client(transport=httpx.MockTransport(self.handler))
        return TukuPay(options.pop("api_key", "sk_test_abc"), http_client=http, **options)

    @property
    def paths(self):
        return [call.url.path for call in self.calls]


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    slept = []
    monkeypatch.setattr("time.sleep", slept.append)
    return slept
