from __future__ import annotations

import argparse
import json
import logging
import os
import random
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse, urlunparse

from websockets.sync.client import connect

from .protocol import ReplayWindow, make_envelope, sign_envelope, verify_envelope
from .secret_store import load_config
from .session_farm_bridge import SessionFarmBridge
from .stdio_mcp import StdioMcpClient

LOG = logging.getLogger("transductive_windows_mcp")


def websocket_url(worker_url: str, device_id: str) -> str:
    u = urlparse(worker_url)
    scheme = "wss" if u.scheme == "https" else "ws" if u.scheme == "http" else u.scheme
    if scheme not in {"ws", "wss"}:
        raise ValueError("worker_url must be http(s) or ws(s)")
    path = u.path.rstrip("/") + "/agent/connect"
    return urlunparse((scheme, u.netloc, path, "", f"device={quote(device_id)}", ""))


def _send_signed(ws: Any, kind: str, device_id: str, op_id: str, body: Any, secret: str) -> None:
    frame = sign_envelope(make_envelope(kind, device_id, op_id, body), secret)
    ws.send(json.dumps(frame, ensure_ascii=False, separators=(",", ":")))


def run_connection(
    worker_url: str,
    device_id: str,
    secret: str,
    upstream: StdioMcpClient,
    farm: SessionFarmBridge,
) -> None:
    url = websocket_url(worker_url, device_id)
    replay = ReplayWindow()
    LOG.info("connecting device=%s endpoint=%s", device_id, url)
    with connect(
        url,
        additional_headers={"Authorization": f"Bearer {secret}"},
        open_timeout=15,
        ping_interval=20,
        ping_timeout=20,
        max_size=16 * 1024 * 1024,
    ) as ws:
        hello_raw = ws.recv(timeout=20)
        hello = json.loads(hello_raw.decode() if isinstance(hello_raw, bytes) else hello_raw)
        if not verify_envelope(hello, secret) or hello.get("kind") != "hello":
            raise RuntimeError("invalid Worker hello")
        LOG.info("relay connected; upstream=%s protocol=%s", upstream.server_info, upstream.negotiated_protocol)
        while True:
            raw = ws.recv()
            message = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
            if not verify_envelope(message, secret):
                LOG.warning("discarded invalid relay envelope")
                continue
            if not replay.accept(str(message.get("deviceId", "")), str(message.get("nonce", ""))):
                LOG.warning("discarded replayed relay envelope")
                continue
            if message.get("kind") != "command":
                continue
            if message.get("deviceId") != device_id:
                LOG.warning("discarded envelope for wrong device")
                continue
            op_id = str(message.get("opId") or "")
            body = message.get("body") or {}
            name = body.get("name")
            args = body.get("arguments") or {}
            if not isinstance(name, str) or not isinstance(args, dict):
                _send_signed(ws, "error", device_id, op_id, {"error": "INVALID_COMMAND"}, secret)
                continue
            try:
                value = farm.call(name, args) if farm.handles(name) else upstream.call_tool(name, args)
                _send_signed(ws, "result", device_id, op_id, {"result": value}, secret)
            except Exception as exc:
                LOG.exception("device tool failed name=%s", name)
                _send_signed(ws, "error", device_id, op_id, {"error": str(exc)}, secret)


def run_forever(config: dict[str, Any]) -> None:
    worker_url = str(config["workerUrl"]).rstrip("/")
    device_id = str(config["deviceId"])
    secret = str(config["deviceSecret"])
    upstream_command = config.get("upstreamCommand") or ["winrdp-mcp", "agent"]
    if isinstance(upstream_command, str):
        command: str | list[str] = upstream_command
    else:
        command = [str(x) for x in upstream_command]
    delay = 1.0
    farm = SessionFarmBridge(config)
    with StdioMcpClient(command, request_timeout=float(config.get("toolTimeoutSeconds", 120))) as upstream:
        tools = upstream.list_tools()
        LOG.info("upstream ready tools=%d local_session_farm_tools=12", len(tools))
        while True:
            try:
                run_connection(worker_url, device_id, secret, upstream, farm)
                delay = 1.0
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                LOG.warning("relay connection lost: %s", exc)
                sleep_for = min(60.0, delay) + random.random() * min(2.0, delay / 4)
                time.sleep(sleep_for)
                delay = min(60.0, delay * 2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Transductive user-owned Windows MCP relay")
    parser.add_argument("--config", type=Path, default=None, help="DPAPI-protected device config path")
    parser.add_argument("--log-level", default=os.environ.get("TRANSDUCTIVE_LOG_LEVEL", "INFO"))
    args = parser.parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    config = load_config(args.config)
    required = {"workerUrl", "deviceId", "deviceSecret"}
    missing = required.difference(config)
    if missing:
        parser.error("missing config fields: " + ", ".join(sorted(missing)))
    run_forever(config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
