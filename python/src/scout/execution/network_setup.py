"""Isolated network namespace routing sandbox egress only through the proxy."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_HOST_VETH_PREFIX = "scout-vh"
_NS_VETH_NAME = "scout-vp"
_HOST_GATEWAY = "10.255.0.1"
_NS_ADDRESS = "10.255.0.2"
_NS_CIDR = "10.255.0.0/24"
_PROXY_LISTEN_PORT = 7892


@dataclass(frozen=True)
class IsolatedNetwork:
    """A network namespace whose only egress path is the Scout egress proxy."""

    ns_name: str
    host_veth: str
    proxy_url: str


def network_isolation_available() -> bool:
    """Return True when ``ip netns`` can be created (requires CAP_NET_ADMIN)."""
    if shutil.which("ip") is None:
        return False
    tag = f"scout-probe-{uuid.uuid4().hex[:8]}"
    try:
        _run(["ip", "netns", "add", tag])
        _run(["ip", "netns", "del", tag])
        return True
    except (subprocess.CalledProcessError, FileNotFoundError, PermissionError):
        return False


def _run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def _resolve_proxy_endpoint(proxy_url: str) -> tuple[str, int]:
    parsed = urlparse(proxy_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or _PROXY_LISTEN_PORT
    return host, port


class IsolatedNetworkManager:
    """Create per-execution network namespaces with proxy-only egress."""

    def __init__(self, proxy_url: str) -> None:
        self._proxy_url = proxy_url
        self._proxy_host, self._proxy_port = _resolve_proxy_endpoint(proxy_url)

    def create(self) -> IsolatedNetwork:
        if not network_isolation_available():
            raise RuntimeError(
                "Network namespace isolation requires root/CAP_NET_ADMIN and the iproute2 'ip' tool"
            )

        tag = uuid.uuid4().hex[:10]
        ns_name = f"scout-{tag}"
        host_veth = f"{_HOST_VETH_PREFIX}-{tag}"

        _run(["ip", "netns", "add", ns_name])
        try:
            _run([
                "ip", "link", "add", host_veth, "type", "veth",
                "peer", "name", _NS_VETH_NAME,
            ])
            _run(["ip", "link", "set", _NS_VETH_NAME, "netns", ns_name])
            _run(["ip", "addr", "add", f"{_HOST_GATEWAY}/24", "dev", host_veth])
            _run(["ip", "link", "set", host_veth, "up"])

            _run([
                "ip", "netns", "exec", ns_name, "ip", "addr", "add",
                f"{_NS_ADDRESS}/24", "dev", _NS_VETH_NAME,
            ])
            _run(["ip", "netns", "exec", ns_name, "ip", "link", "set", _NS_VETH_NAME, "up"])
            _run(["ip", "netns", "exec", ns_name, "ip", "link", "set", "lo", "up"])
            _run([
                "ip", "netns", "exec", ns_name, "ip", "route", "add", "default",
                "via", _HOST_GATEWAY,
            ])

            _run([
                "iptables", "-t", "nat", "-A", "PREROUTING",
                "-s", _NS_ADDRESS, "-p", "tcp", "--dport", str(_PROXY_LISTEN_PORT),
                "-j", "DNAT", "--to-destination", f"{self._proxy_host}:{self._proxy_port}",
            ])
            _run([
                "iptables", "-A", "FORWARD",
                "-s", _NS_CIDR, "-d", self._proxy_host,
                "-p", "tcp", "--dport", str(self._proxy_port), "-j", "ACCEPT",
            ])
            _run(["iptables", "-A", "FORWARD", "-s", _NS_CIDR, "-j", "DROP"])

            return IsolatedNetwork(
                ns_name=ns_name,
                host_veth=host_veth,
                proxy_url=f"http://{_HOST_GATEWAY}:{_PROXY_LISTEN_PORT}",
            )
        except Exception:
            self.destroy(IsolatedNetwork(ns_name=ns_name, host_veth=host_veth, proxy_url=""))
            raise

    def destroy(self, net: IsolatedNetwork) -> None:
        for cmd in (
            ["iptables", "-D", "FORWARD", "-s", _NS_CIDR, "-j", "DROP"],
            [
                "iptables", "-D", "FORWARD",
                "-s", _NS_CIDR, "-d", self._proxy_host,
                "-p", "tcp", "--dport", str(self._proxy_port), "-j", "ACCEPT",
            ],
            [
                "iptables", "-t", "nat", "-D", "PREROUTING",
                "-s", _NS_ADDRESS, "-p", "tcp", "--dport", str(_PROXY_LISTEN_PORT),
                "-j", "DNAT", "--to-destination", f"{self._proxy_host}:{self._proxy_port}",
            ],
        ):
            _run(cmd, check=False)

        _run(["ip", "link", "del", net.host_veth], check=False)
        _run(["ip", "netns", "del", net.ns_name], check=False)


def wrap_command_in_netns(command: list[str], net: IsolatedNetwork) -> list[str]:
    """Prefix *command* to run inside *net*'s namespace."""
    return ["ip", "netns", "exec", net.ns_name, *command]
