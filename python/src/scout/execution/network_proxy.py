"""Domain-allowlist egress HTTP proxy for sandboxed network access."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
from dataclasses import dataclass, field
from typing import Iterable
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_DEFAULT_PORT = 7892
_HOST_RE = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$")
_ALLOWED_PORTS = frozenset({80, 443, 8080, 8443})


@dataclass
class EgressProxy:
    """HTTP CONNECT proxy enforcing an approved-domain allowlist."""

    allowed_domains: set[str] = field(default_factory=set)
    host: str = "0.0.0.0"
    port: int = _DEFAULT_PORT
    _server: asyncio.Server | None = field(default=None, repr=False)

    def update_domains(self, domains: Iterable[str]) -> None:
        self.allowed_domains = {d.lower().strip() for d in domains if d.strip()}

    def _domain_allowed(self, host: str) -> bool:
        host = host.lower().strip().rstrip(".")
        if not host or host in {"localhost", "127.0.0.1", "::1"}:
            return False
        try:
            ipaddress.ip_address(host)
            return False
        except ValueError:
            pass
        if ":" in host:
            return False
        if not _HOST_RE.match(host):
            return False
        for allowed in self.allowed_domains:
            if host == allowed or host.endswith("." + allowed):
                return True
        return False

    async def _resolve_ipv4(self, host: str) -> str | None:
        """Resolve *host* to IPv4 only; reject private/metadata addresses."""
        if not self._domain_allowed(host):
            return None
        try:
            infos = await asyncio.get_event_loop().getaddrinfo(
                host, None, family=socket.AF_INET, type=socket.SOCK_STREAM,
            )
        except socket.gaierror:
            return None
        for info in infos:
            addr = info[4][0]
            try:
                ip = ipaddress.ip_address(addr)
            except ValueError:
                continue
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return None
            return addr
        return None

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
    ) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=10)
            if not request_line:
                return
            parts = request_line.decode("utf-8", errors="replace").strip().split()
            if len(parts) < 2:
                writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                await writer.drain()
                return

            method, target = parts[0].upper(), parts[1]
            headers: list[bytes] = []
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                headers.append(line)

            host: str
            port: int
            if method == "CONNECT":
                if ":" in target:
                    host, port_s = target.rsplit(":", 1)
                    port = int(port_s)
                else:
                    host, port = target, 443
            elif method in {"GET", "POST", "HEAD", "PUT", "DELETE", "PATCH"}:
                parsed = urlparse(target)
                host = parsed.hostname or ""
                port = parsed.port or (443 if parsed.scheme == "https" else 80)
            else:
                writer.write(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
                await writer.drain()
                return

            if port not in _ALLOWED_PORTS:
                writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                await writer.drain()
                return

            resolved = await self._resolve_ipv4(host)
            if resolved is None:
                writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                return

            try:
                remote_reader, remote_writer = await asyncio.wait_for(
                    asyncio.open_connection(resolved, port),
                    timeout=15,
                )
            except (OSError, asyncio.TimeoutError):
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                await writer.drain()
                return

            if method == "CONNECT":
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            else:
                remote_writer.write(request_line)
                for h in headers:
                    remote_writer.write(h)
                remote_writer.write(b"\r\n")
                await remote_writer.drain()

            await asyncio.gather(
                self._pipe(reader, remote_writer, check_redirects=False),
                self._pipe(remote_reader, writer, check_redirects=True),
            )
        except Exception as exc:
            logger.debug("proxy client error: %s", exc)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _pipe(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        check_redirects: bool,
    ) -> None:
        try:
            while True:
                data = await reader.read(8192)
                if not data:
                    break
                if check_redirects and data.startswith(b"HTTP/"):
                    try:
                        head = data.decode("utf-8", errors="replace").split("\r\n", 1)[0]
                        if " 301 " in head or " 302 " in head or " 307 " in head or " 308 " in head:
                            for line in data.decode("utf-8", errors="replace").splitlines():
                                if line.lower().startswith("location:"):
                                    loc = line.split(":", 1)[1].strip()
                                    parsed = urlparse(loc)
                                    redirect_host = parsed.hostname or ""
                                    if not self._domain_allowed(redirect_host):
                                        writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                                        await writer.drain()
                                        return
                    except Exception:
                        pass
                writer.write(data)
                await writer.drain()
        except Exception:
            pass

    async def start(self) -> None:
        if self._server is not None:
            return
        self._server = await asyncio.start_server(
            self._handle_client, self.host, self.port,
            family=socket.AF_INET,
        )
        logger.info("Egress proxy listening on %s:%s", self.host, self.port)

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    @property
    def proxy_url(self) -> str:
        bind_host = "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host
        return f"http://{bind_host}:{self.port}"
