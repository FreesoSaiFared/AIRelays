from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
import uuid
from typing import Any

DEVICE_PROTOCOL = "TRANSDUCTIVE_DEVICE_RELAY/1"
DEFAULT_MAX_SKEW_MS = 120_000


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_unsigned(envelope: dict[str, Any]) -> str:
    return canonical_json({
        "protocol": envelope["protocol"],
        "kind": envelope["kind"],
        "deviceId": envelope["deviceId"],
        "opId": envelope["opId"],
        "nonce": envelope["nonce"],
        "ts": envelope["ts"],
        "body": envelope.get("body"),
    })


def sign_envelope(envelope: dict[str, Any], secret: str) -> dict[str, Any]:
    unsigned = canonical_unsigned(envelope).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), unsigned, hashlib.sha256).hexdigest()
    return {**envelope, "sig": sig}


def verify_envelope(
    envelope: dict[str, Any],
    secret: str,
    *,
    now_ms: int | None = None,
    max_skew_ms: int = DEFAULT_MAX_SKEW_MS,
) -> bool:
    try:
        if envelope.get("protocol") != DEVICE_PROTOCOL:
            return False
        sig = envelope.get("sig")
        if not isinstance(sig, str) or len(sig) != 64:
            return False
        int(sig, 16)
        ts = envelope.get("ts")
        if not isinstance(ts, (int, float)):
            return False
        now = int(time.time() * 1000) if now_ms is None else now_ms
        if abs(now - int(ts)) > max_skew_ms:
            return False
        expected = sign_envelope({k: v for k, v in envelope.items() if k != "sig"}, secret)["sig"]
        return hmac.compare_digest(sig.lower(), expected.lower())
    except (KeyError, TypeError, ValueError):
        return False


def make_envelope(kind: str, device_id: str, op_id: str, body: Any, *, now_ms: int | None = None) -> dict[str, Any]:
    return {
        "protocol": DEVICE_PROTOCOL,
        "kind": kind,
        "deviceId": device_id,
        "opId": op_id,
        "nonce": str(uuid.uuid4()),
        "ts": int(time.time() * 1000) if now_ms is None else int(now_ms),
        "body": body,
    }


class ReplayWindow:
    """Bounded in-memory replay detector for signed relay frames."""

    def __init__(self, limit: int = 4096) -> None:
        self.limit = limit
        self._seen: dict[str, None] = {}

    def accept(self, device_id: str, nonce: str) -> bool:
        key = f"{device_id}:{nonce}"
        if key in self._seen:
            return False
        self._seen[key] = None
        if len(self._seen) > self.limit:
            trim = max(1, self.limit // 2)
            for old in list(self._seen)[:trim]:
                self._seen.pop(old, None)
        return True


def generate_device_secret() -> str:
    return secrets.token_urlsafe(32)
