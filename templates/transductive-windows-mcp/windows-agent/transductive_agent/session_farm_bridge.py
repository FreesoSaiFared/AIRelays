from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

FARM_TOOLS = {
    "farm_deploy", "farm_start", "farm_status", "farm_tick", "farm_ensure_tabs",
    "farm_continue", "farm_pause", "farm_resume", "farm_bind", "farm_guard", "farm_stop",
}
WORKERS = {f"w{i}" for i in range(1, 7)}
SLOTS = WORKERS | {"orch"}


def _program_data() -> Path:
    return Path(os.environ.get("ProgramData") or os.environ.get("PROGRAMDATA") or r"C:\ProgramData")


class SessionFarmBridge:
    """Fixed-function bridge from the durable Windows relay into AIRelays Session Farm.

    This deliberately does not expose a generic shell. The only process launch is the
    canonical deployer or daemon entrypoint under a validated AIRelays repository root.
    """

    def __init__(self, device_config: dict[str, Any]) -> None:
        self.device_config = device_config
        self.settings_path = _program_data() / "Transductive" / "WindowsMCP" / "session-farm-bridge.json"

    def handles(self, name: str) -> bool:
        return name in FARM_TOOLS

    def _load_settings(self) -> dict[str, Any]:
        try:
            data = json.loads(self.settings_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _save_settings(self, settings: dict[str, Any]) -> None:
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.settings_path.with_suffix(f".tmp.{os.getpid()}")
        tmp.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.settings_path)

    def _repo_root(self, args: dict[str, Any], *, required: bool = True) -> Path | None:
        settings = self._load_settings()
        raw = args.get("repoRoot") or settings.get("repoRoot") or self.device_config.get("airelaysRepoRoot") or os.environ.get("AIRELAYS_REPO_ROOT")
        if not raw:
            if required:
                raise RuntimeError("AIRelays repository root is not configured; pass repoRoot once to farm_deploy or farm_start")
            return None
        root = Path(str(raw)).expanduser().resolve()
        marker = root / "tools" / "session-farm" / "session-farm.mjs"
        if not marker.is_file():
            raise RuntimeError(f"invalid AIRelays repoRoot; missing {marker}")
        return root

    def _config_path(self, args: dict[str, Any]) -> Path:
        settings = self._load_settings()
        raw = args.get("configPath") or settings.get("configPath") or self.device_config.get("sessionFarmConfigPath") or os.environ.get("AIRELAYS_SESSION_FARM_CONFIG")
        if raw:
            return Path(str(raw)).expanduser().resolve()
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            local = str(_program_data() / "Transductive" / "WindowsMCP")
        return (Path(local) / "AIRelays" / "session-farm" / "session-farm.config.json").resolve()

    def _remember(self, repo_root: Path | None, config_path: Path) -> None:
        settings = self._load_settings()
        if repo_root is not None:
            settings["repoRoot"] = str(repo_root)
        settings["configPath"] = str(config_path)
        self._save_settings(settings)

    def _origin(self, config_path: Path) -> str:
        try:
            config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError as exc:
            raise RuntimeError(f"session-farm config does not exist: {config_path}") from exc
        listen = config.get("listen") or {}
        host = str(listen.get("host") or "127.0.0.1")
        port = int(listen.get("port") or 39817)
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise RuntimeError(f"refusing non-loopback session-farm control host: {host}")
        return f"http://{host}:{port}"

    def _http(self, config_path: Path, path: str, *, body: dict[str, Any] | None = None, timeout: float = 12.0) -> Any:
        url = self._origin(config_path) + path
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method="GET" if body is None else "POST",
            headers={"content-type": "application/json", "user-agent": "transductive-windows-mcp/session-farm"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise RuntimeError(f"session-farm HTTP {exc.code} {path}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"session-farm unavailable at {url}: {exc.reason}") from exc

    def _healthy(self, config_path: Path) -> bool:
        try:
            value = self._http(config_path, "/healthz", timeout=1.5)
            return bool(value.get("ok"))
        except Exception:
            return False

    def _node(self) -> str:
        node = shutil.which("node.exe") or shutil.which("node")
        if not node:
            raise RuntimeError("Node.js 22+ is required but node.exe was not found on PATH")
        return node

    def _powershell(self) -> str:
        value = shutil.which("powershell.exe") or shutil.which("powershell")
        if not value:
            raise RuntimeError("powershell.exe was not found")
        return value

    def _start(self, repo_root: Path, config_path: Path) -> dict[str, Any]:
        if self._healthy(config_path):
            return {"ok": True, "alreadyRunning": True, "configPath": str(config_path)}
        entry = repo_root / "tools" / "session-farm" / "session-farm.mjs"
        creationflags = 0
        for name in ("CREATE_NEW_PROCESS_GROUP", "DETACHED_PROCESS", "CREATE_NO_WINDOW"):
            creationflags |= int(getattr(subprocess, name, 0))
        proc = subprocess.Popen(
            [self._node(), str(entry), "--config", str(config_path)],
            cwd=str(repo_root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
        )
        deadline = time.monotonic() + 12.0
        while time.monotonic() < deadline:
            if self._healthy(config_path):
                return {"ok": True, "alreadyRunning": False, "pid": proc.pid, "configPath": str(config_path)}
            if proc.poll() is not None:
                raise RuntimeError(f"session-farm daemon exited early with code {proc.returncode}")
            time.sleep(0.25)
        raise RuntimeError(f"session-farm daemon did not become healthy; launcher pid={proc.pid}")

    def _deploy(self, args: dict[str, Any]) -> dict[str, Any]:
        root = self._repo_root(args, required=True)
        assert root is not None
        config_path = self._config_path(args)
        script = root / "tools" / "session-farm" / "deploy-windows.ps1"
        if not script.is_file():
            raise RuntimeError(f"canonical deployer missing: {script}")
        cmd = [self._powershell(), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-RepoRoot", str(root), "-ConfigPath", str(config_path)]
        if bool(args.get("updateFromMain", True)):
            cmd.append("-UpdateFromMain")
        if bool(args.get("enableSelfHealing", True)):
            cmd.append("-EnableSelfHealing")
        if bool(args.get("startNow", True)):
            cmd.append("-StartNow")
        if bool(args.get("validationOnly", False)):
            cmd.append("-ValidationOnly")
        completed = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
        receipt = {
            "ok": completed.returncode == 0,
            "exitCode": completed.returncode,
            "repoRoot": str(root),
            "configPath": str(config_path),
            "stdout": completed.stdout[-30000:],
            "stderr": completed.stderr[-12000:],
        }
        if completed.returncode != 0:
            raise RuntimeError(json.dumps(receipt, ensure_ascii=False))
        self._remember(root, config_path)
        return receipt

    @staticmethod
    def _worker(args: dict[str, Any]) -> str:
        value = str(args.get("worker") or "")
        if value not in WORKERS:
            raise RuntimeError("worker must be one of w1..w6")
        return value

    def call(self, name: str, args: dict[str, Any]) -> Any:
        if name not in FARM_TOOLS:
            raise RuntimeError(f"unsupported session-farm tool: {name}")
        if name == "farm_deploy":
            return self._deploy(args)

        config_path = self._config_path(args)
        root = self._repo_root(args, required=name == "farm_start")
        if root is not None or args.get("configPath"):
            self._remember(root, config_path)

        if name == "farm_start":
            assert root is not None
            return self._start(root, config_path)
        if name == "farm_status":
            return self._http(config_path, "/status")
        if name == "farm_tick":
            return self._http(config_path, "/tick", body={})
        if name == "farm_ensure_tabs":
            return self._http(config_path, "/ensure-tabs", body={})
        if name == "farm_continue":
            body: dict[str, Any] = {"worker": self._worker(args)}
            if "prompt" in args and args["prompt"] is not None:
                body["prompt"] = str(args["prompt"])
            return self._http(config_path, "/continue", body=body)
        if name in {"farm_pause", "farm_resume"}:
            return self._http(config_path, "/" + name.removeprefix("farm_"), body={"worker": self._worker(args)})
        if name == "farm_bind":
            slot = str(args.get("slot") or "")
            if slot not in SLOTS:
                raise RuntimeError("slot must be w1..w6 or orch")
            url = str(args.get("url") or "").strip()
            if not url.startswith("https://chatgpt.com/"):
                raise RuntimeError("farm_bind only accepts https://chatgpt.com/ URLs")
            return self._http(config_path, "/bind", body={"slot": slot, "url": url})
        if name == "farm_guard":
            return self._http(config_path, "/guard", body={})
        if name == "farm_stop":
            return self._http(config_path, "/shutdown", body={})
        raise RuntimeError(f"unreachable session-farm tool: {name}")
