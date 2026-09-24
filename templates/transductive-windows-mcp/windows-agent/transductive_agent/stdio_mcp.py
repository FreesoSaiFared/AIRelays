from __future__ import annotations

import json
import queue
import shlex
import subprocess
import threading
from dataclasses import dataclass
from typing import Any, Sequence


class McpError(RuntimeError):
    pass


class McpTimeout(McpError):
    pass


@dataclass
class _Pending:
    event: threading.Event
    response: dict[str, Any] | None = None


class StdioMcpClient:
    """Small JSON-RPC MCP stdio client used to project upstream winrdp-mcp unchanged."""

    def __init__(
        self,
        command: Sequence[str] | str,
        *,
        request_timeout: float = 60.0,
        protocol_version: str = "2025-11-25",
    ) -> None:
        self.command = shlex.split(command) if isinstance(command, str) else list(command)
        if not self.command:
            raise ValueError("empty MCP command")
        self.request_timeout = request_timeout
        self.protocol_version = protocol_version
        self._proc: subprocess.Popen[str] | None = None
        self._next_id = 1
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending: dict[int, _Pending] = {}
        self._notifications: queue.Queue[dict[str, Any]] = queue.Queue()
        self._stderr: queue.Queue[str] = queue.Queue(maxsize=512)
        self.server_info: dict[str, Any] = {}
        self.negotiated_protocol: str | None = None

    def start(self) -> "StdioMcpClient":
        if self._proc and self._proc.poll() is None:
            return self
        self._proc = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        threading.Thread(target=self._read_stdout, name="mcp-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="mcp-stderr", daemon=True).start()
        init = self.request(
            "initialize",
            {
                "protocolVersion": self.protocol_version,
                "capabilities": {},
                "clientInfo": {"name": "transductive-windows-relay", "version": "0.1.0"},
            },
        )
        self.negotiated_protocol = str(init.get("protocolVersion", self.protocol_version))
        self.server_info = dict(init.get("serverInfo") or {})
        self.notify("notifications/initialized", {})
        return self

    def _read_stdout(self) -> None:
        assert self._proc and self._proc.stdout
        for raw in self._proc.stdout:
            line = raw.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg_id = message.get("id")
            if msg_id is None:
                self._notifications.put(message)
                continue
            try:
                key = int(msg_id)
            except (TypeError, ValueError):
                continue
            with self._lock:
                pending = self._pending.get(key)
                if pending:
                    pending.response = message
                    pending.event.set()
        self._fail_pending("MCP child stdout closed")

    def _read_stderr(self) -> None:
        assert self._proc and self._proc.stderr
        for raw in self._proc.stderr:
            line = raw.rstrip("\r\n")
            if not line:
                continue
            try:
                self._stderr.put_nowait(line)
            except queue.Full:
                try:
                    self._stderr.get_nowait()
                except queue.Empty:
                    pass
                try:
                    self._stderr.put_nowait(line)
                except queue.Full:
                    pass

    def _fail_pending(self, message: str) -> None:
        with self._lock:
            for item in self._pending.values():
                item.response = {"jsonrpc": "2.0", "error": {"code": -32099, "message": message}}
                item.event.set()

    def _send(self, message: dict[str, Any]) -> None:
        if not self._proc or self._proc.poll() is not None or not self._proc.stdin:
            raise McpError("MCP child is not running")
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._write_lock:
            self._proc.stdin.write(payload)
            self._proc.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        with self._lock:
            req_id = self._next_id
            self._next_id += 1
            pending = _Pending(threading.Event())
            self._pending[req_id] = pending
        try:
            self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}})
            wait_for = self.request_timeout if timeout is None else timeout
            if not pending.event.wait(wait_for):
                raise McpTimeout(f"timeout waiting for MCP method {method}")
            response = pending.response or {}
            if "error" in response:
                err = response["error"] or {}
                raise McpError(f"{method}: {err.get('message', 'MCP error')} ({err.get('code', '?')})")
            return response.get("result")
        finally:
            with self._lock:
                self._pending.pop(req_id, None)

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def list_tools(self) -> list[dict[str, Any]]:
        value = self.request("tools/list", {})
        return list((value or {}).get("tools") or [])

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        return self.request("tools/call", {"name": name, "arguments": arguments or {}})

    def recent_stderr(self, limit: int = 30) -> list[str]:
        values: list[str] = []
        while len(values) < limit:
            try:
                values.append(self._stderr.get_nowait())
            except queue.Empty:
                break
        return values

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        if not proc:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)

    def __enter__(self) -> "StdioMcpClient":
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.close()
