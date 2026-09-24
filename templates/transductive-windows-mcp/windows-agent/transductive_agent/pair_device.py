from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from .secret_store import save_config


def claim(worker_url: str, code: str, *, timeout: float = 20.0) -> dict:
    url = worker_url.rstrip('/') + '/agent/pair/claim'
    req = urllib.request.Request(
        url,
        data=json.dumps({'code': code.strip().upper()}, separators=(',', ':')).encode('utf-8'),
        headers={'content-type': 'application/json', 'user-agent': 'transductive-windows-mcp/0.1'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', 'replace')
        raise RuntimeError(f'pairing failed: HTTP {exc.code}: {detail}') from exc
    if data.get('protocol') != 'TRANSDUCTIVE_DEVICE_PAIRING/1':
        raise RuntimeError('pairing response used an unsupported protocol')
    for field in ('workerUrl', 'deviceId', 'deviceSecret'):
        if not data.get(field):
            raise RuntimeError(f'pairing response missing {field}')
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Pair this Windows machine to a user-owned Transductive MCP Worker')
    parser.add_argument('--worker', required=True, help='https://<your-worker>.workers.dev')
    parser.add_argument('--code', required=True, help='one-time pairing code shown by the Worker')
    parser.add_argument('--config', type=Path, default=None, help='override DPAPI device-config path')
    parser.add_argument('--upstream-command', default='winrdp-mcp agent')
    args = parser.parse_args(argv)

    data = claim(args.worker, args.code)
    config = {
        'schema': 'TRANSDUCTIVE_WINDOWS_MCP_DEVICE/1',
        'workerUrl': data['workerUrl'],
        'deviceId': data['deviceId'],
        'deviceSecret': data['deviceSecret'],
        'ownerPrincipal': data.get('ownerPrincipal'),
        'label': data.get('label'),
        'upstreamCommand': args.upstream_command,
    }
    path = save_config(config, args.config)
    print(json.dumps({
        'paired': True,
        'deviceId': config['deviceId'],
        'workerUrl': config['workerUrl'],
        'label': config.get('label'),
        'configPath': str(path),
        'secretStoredWith': 'Windows DPAPI LocalMachine' if sys.platform == 'win32' else '0600 fixture file',
    }, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
