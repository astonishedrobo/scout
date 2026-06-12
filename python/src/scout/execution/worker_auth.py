"""Authenticated worker RPC with replay protection."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any

from fastapi import HTTPException

_MAX_BODY_BYTES = 512_000
_MAX_CLOCK_SKEW_SECONDS = 120
_NONCE_TTL_SECONDS = 300

_SEEN_NONCES: dict[str, float] = {}


def require_worker_secret() -> str:
    secret = os.environ.get("SCOUT_WORKER_SECRET", "")
    if not secret or secret == "scout-worker-dev-secret":
        if os.environ.get("SCOUT_ENV", "").lower() in {"production", "prod"}:
            raise RuntimeError("SCOUT_WORKER_SECRET must be set in production")
    return secret or "scout-worker-dev-secret"


def _purge_nonces() -> None:
    now = time.time()
    expired = [n for n, ts in _SEEN_NONCES.items() if now - ts > _NONCE_TTL_SECONDS]
    for n in expired:
        del _SEEN_NONCES[n]


def verify_bearer(authorization: str | None) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization[7:]
    if not hmac.compare_digest(token, require_worker_secret()):
        raise HTTPException(status_code=403, detail="Invalid worker token")


def verify_signed_request(
    *,
    authorization: str | None,
    body: bytes,
    signature: str | None,
    timestamp: str | None,
    nonce: str | None,
    authenticated_user_id: str | None = None,
    payload_user_id: str | None = None,
) -> None:
    """Verify bearer token, size limits, timestamp, nonce, and identity binding."""
    verify_bearer(authorization)

    if len(body) > _MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Request too large")

    if authenticated_user_id and payload_user_id:
        if authenticated_user_id != payload_user_id:
            raise HTTPException(status_code=403, detail="Identity mismatch")

    if not (signature and timestamp and nonce):
        raise HTTPException(status_code=403, detail="Missing signed request headers")

    try:
        ts = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid timestamp") from exc

    now = int(time.time())
    if abs(now - ts) > _MAX_CLOCK_SKEW_SECONDS:
        raise HTTPException(status_code=403, detail="Request expired")

    _purge_nonces()
    if nonce in _SEEN_NONCES:
        raise HTTPException(status_code=403, detail="Replay detected")
    _SEEN_NONCES[nonce] = time.time()

    secret = require_worker_secret().encode()
    digest = hmac.new(secret, body + timestamp.encode() + nonce.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(digest, signature):
        raise HTTPException(status_code=403, detail="Invalid signature")


def sign_request_body(body: dict[str, Any], *, secret: str | None = None) -> dict[str, str]:
    """Build signed headers for API → worker requests."""
    key = (secret or require_worker_secret()).encode()
    payload = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    timestamp = str(int(time.time()))
    import uuid
    nonce = uuid.uuid4().hex
    signature = hmac.new(key, payload + timestamp.encode() + nonce.encode(), hashlib.sha256).hexdigest()
    return {
        "X-Scout-Timestamp": timestamp,
        "X-Scout-Nonce": nonce,
        "X-Scout-Signature": signature,
    }
