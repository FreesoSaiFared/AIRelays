from __future__ import annotations

import argparse
import sys

from . import pair_device, relay_agent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='transductive-windows-mcp')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('pair', help='claim a one-time pairing code')
    sub.add_parser('relay', help='run the persistent Worker-to-winrdp relay')
    ns, rest = parser.parse_known_args(argv)
    if ns.command == 'pair':
        return pair_device.main(rest)
    return relay_agent.main(rest)


if __name__ == '__main__':
    raise SystemExit(main())
