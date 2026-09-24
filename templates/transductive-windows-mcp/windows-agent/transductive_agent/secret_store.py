from __future__ import annotations

import base64
import ctypes
import json
import os
from ctypes import wintypes
from pathlib import Path
from typing import Any


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes) -> tuple[_DataBlob, Any]:
    buf = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte))), buf


def _dpapi_protect(data: bytes) -> bytes:
    if os.name != "nt":
        return data
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    src, keep = _blob(data)
    out = _DataBlob()
    CRYPTPROTECT_LOCAL_MACHINE = 0x4
    ok = crypt32.CryptProtectData(ctypes.byref(src), "Transductive Windows MCP", None, None, None,
                                  CRYPTPROTECT_LOCAL_MACHINE, ctypes.byref(out))
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def _dpapi_unprotect(data: bytes) -> bytes:
    if os.name != "nt":
        return data
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    src, keep = _blob(data)
    out = _DataBlob()
    ok = crypt32.CryptUnprotectData(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out))
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def default_config_path() -> Path:
    if os.name == "nt":
        root = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData"))
        return root / "Transductive" / "WindowsMCP" / "device.json.dpapi"
    return Path.home() / ".config" / "transductive-windows-mcp" / "device.json"


def save_config(config: dict[str, Any], path: Path | None = None) -> Path:
    target = path or default_config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    plaintext = json.dumps(config, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ciphertext = _dpapi_protect(plaintext)
    target.write_bytes(base64.b64encode(ciphertext))
    try:
        os.chmod(target, 0o600)
    except OSError:
        pass
    return target


def load_config(path: Path | None = None) -> dict[str, Any]:
    target = path or default_config_path()
    ciphertext = base64.b64decode(target.read_bytes())
    plaintext = _dpapi_unprotect(ciphertext)
    value = json.loads(plaintext.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("device config is not an object")
    return value
