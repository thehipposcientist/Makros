"""Shared rate-limit instance. Defined in its own module so route files
can import the limiter without pulling in `main.py` (which imports them).

Key function respects `X-Forwarded-For` since App Runner / ALB sit in
front of the service and strip the real client IP off the socket.
"""
from __future__ import annotations

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def _key_from_request(request: Request) -> str:
    # App Runner injects `X-Forwarded-For: <client>, <proxy>...`; take the
    # leftmost entry as the real client. Fallback to the socket peer.
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return get_remote_address(request)


limiter = Limiter(key_func=_key_from_request)
