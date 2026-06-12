"""Codex-style unified exec: per-command PTY sessions with yield-based I/O."""

from __future__ import annotations

import asyncio
import logging
import os
import pty
import queue
import select
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

from ..config import ExecutionConfig
from .env import build_execution_env
from .launcher import IO_DRAIN_TIMEOUT, bwrap_available, build_bwrap_command, drain_process_io, kill_process_tree
from .runtime import enrich_execution_env, resolve_sandbox_python
from .models import ExecutionPolicy
from .network_setup import IsolatedNetwork, IsolatedNetworkManager, network_isolation_available, wrap_command_in_netns
from .sandbox_probe import probe_sandbox_isolation

logger = logging.getLogger(__name__)

MIN_YIELD_TIME_MS = 250
MAX_YIELD_TIME_MS = 30_000
MIN_EMPTY_POLL_MS = 5_000
DEFAULT_MAX_OUTPUT_TOKENS = 10_000

OutputChunkCallback = Callable[[str, int, str], None]


def clamp_yield_time(yield_time_ms: int, *, empty_poll: bool = False, max_poll_ms: int = 300_000) -> int:
    if empty_poll:
        return max(MIN_EMPTY_POLL_MS, min(yield_time_ms or MIN_EMPTY_POLL_MS, max_poll_ms))
    ms = yield_time_ms or 10_000
    return max(MIN_YIELD_TIME_MS, min(ms, MAX_YIELD_TIME_MS))


def approx_token_count(text: str) -> int:
    return max(1, len(text) // 4)


def truncate_text(text: str, max_tokens: int) -> str:
    max_chars = max_tokens * 4
    if len(text) <= max_chars:
        return text
    head = max_chars // 2
    tail = max_chars // 4
    return text[:head] + "\n…[truncated]…\n" + text[-tail:]


@dataclass
class UnifiedExecResponse:
    output: str
    wall_time_seconds: float
    process_id: int | None = None
    exit_code: int | None = None
    chunk_id: str = ""
    error: str | None = None
    alive: bool = False
    changed_files: list = field(default_factory=list)
    artifacts: list = field(default_factory=list)


@dataclass
class UnifiedExecCommandRequest:
    execution_id: str
    user_id: str
    session_id: str
    command: str
    cwd: Path
    policy: ExecutionPolicy
    staging_dir: Path | None
    work_dir: Path | None
    yield_time_ms: int
    max_output_tokens: int
    tty: bool = True
    tool_call_id: str = ""
    proxy_url: str | None = None
    allow_insecure_fallback: bool = False
    sandbox_python: str = ""


@dataclass
class UnifiedExecStdinRequest:
    user_id: str
    session_id: str
    process_id: int
    chars: str
    yield_time_ms: int
    max_output_tokens: int
    tool_call_id: str = ""


class HeadTailBuffer:
    """Bounded buffer keeping head and tail of streamed output."""

    def __init__(self, max_bytes: int = 100_000) -> None:
        self._max = max_bytes
        self._data = bytearray()
        self._lock = threading.Lock()

    def append(self, chunk: bytes) -> str:
        with self._lock:
            self._data.extend(chunk)
            if len(self._data) > self._max:
                half = self._max // 2
                tail = self._max // 4
                self._data = self._data[:half] + b"\n...[truncated]...\n" + self._data[-tail:]
            return self._data.decode("utf-8", errors="replace")

    def snapshot(self) -> bytes:
        with self._lock:
            return bytes(self._data)


@dataclass
class _ProcessEntry:
    process_id: int
    user_id: str
    session_id: str
    execution_id: str
    command: str
    cwd: Path
    policy: ExecutionPolicy
    staging_dir: Path | None
    work_dir: Path | None
    proc: subprocess.Popen[bytes]
    master_fd: int
    buffer: HeadTailBuffer
    output_notify: threading.Event
    reader_thread: threading.Thread
    tool_call_id: str
    call_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    proxy_url: str | None = None
    net: IsolatedNetwork | None = None
    net_mgr: IsolatedNetworkManager | None = None


class UnifiedExecManager:
    """Per-backend manager for Codex-style shell sessions."""

    def __init__(
        self,
        config: ExecutionConfig,
        *,
        on_chunk: OutputChunkCallback | None = None,
    ) -> None:
        self._config = config
        self._on_chunk = on_chunk
        self._probe = probe_sandbox_isolation()
        self._lock = threading.RLock()
        self._processes: dict[int, _ProcessEntry] = {}
        self._next_id = 1
        self._scoped: dict[str, set[int]] = {}
        self._stream_queues: dict[str, queue.Queue[str | None]] = {}

    def set_chunk_callback(self, callback: OutputChunkCallback | None) -> None:
        self._on_chunk = callback

    def register_stream(self, execution_id: str) -> queue.Queue[str | None]:
        q: queue.Queue[str | None] = queue.Queue()
        self._stream_queues[execution_id] = q
        return q

    def unregister_stream(self, execution_id: str) -> None:
        self._stream_queues.pop(execution_id, None)

    def iter_stream(self, execution_id: str, *, timeout: float = 0.5) -> Iterator[str]:
        q = self._stream_queues.get(execution_id)
        if q is None:
            return
        while True:
            try:
                item = q.get(timeout=timeout)
            except queue.Empty:
                continue
            if item is None:
                return
            yield item

    def _scope_key(self, user_id: str, session_id: str) -> str:
        return f"{user_id}:{session_id}"

    def _allocate_id(self) -> int:
        with self._lock:
            pid = self._next_id
            self._next_id += 1
            return pid

    def _emit_chunk(self, entry: _ProcessEntry, delta: str) -> None:
        if not delta:
            return
        stream_q = self._stream_queues.get(entry.execution_id)
        if stream_q is not None:
            try:
                stream_q.put_nowait(delta)
            except queue.Full:
                pass
        if not self._on_chunk:
            return
        try:
            self._on_chunk(entry.tool_call_id or entry.call_id, entry.process_id, delta)
        except Exception:
            logger.debug("chunk callback failed", exc_info=True)

    def _docker_launch_cmd(
        self,
        request: UnifiedExecCommandRequest,
        cmd: list[str],
        env: dict[str, str],
        proxy_url: str | None,
    ) -> list[str] | None:
        try:
            from .container_backend import (
                _env_args,
                _limit_args,
                _mount_args,
                _network_args,
                container_engine_binary,
                sandbox_image,
            )
            from .models import ExecutionRequest
        except ImportError:
            return None
        binary = container_engine_binary()
        image = sandbox_image()
        if not binary or not image:
            return None
        exec_req = ExecutionRequest(
            execution_id=request.execution_id,
            user_id=request.user_id,
            session_id=request.session_id,
            runtime="shell",
            command=None,
            code=None,
            cwd=request.cwd,
            policy=request.policy,
            environment=env,
        )
        net_args, net_env = _network_args(proxy_url, request.policy.network.domains)
        merged = dict(env)
        merged.update(net_env)
        return [
            binary, "run", "--rm", "-i",
            *net_args,
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--read-only",
            "--tmpfs", "/tmp:rw,mode=1777",
            *_limit_args(request.policy),
            *_mount_args(request.user_id),
            "-w", str(request.cwd),
            *_env_args(merged),
            "--label", "scout.execution=1",
            "--label", f"scout.user={request.user_id}",
            image,
            *cmd,
        ]

    def _start_reader(self, entry: _ProcessEntry) -> None:
        def _read() -> None:
            while True:
                if entry.proc.poll() is not None:
                    entry.output_notify.set()
                    break
                try:
                    ready, _, _ = select.select([entry.master_fd], [], [], 0.2)
                    if not ready:
                        continue
                    chunk = os.read(entry.master_fd, 4096)
                    if not chunk:
                        entry.output_notify.set()
                        break
                    text = entry.buffer.append(chunk)
                    self._emit_chunk(entry, chunk.decode("utf-8", errors="replace"))
                    entry.output_notify.set()
                except OSError:
                    break

        entry.reader_thread = threading.Thread(target=_read, daemon=True, name=f"uexec-{entry.process_id}")
        entry.reader_thread.start()

    def _spawn(
        self,
        request: UnifiedExecCommandRequest,
        process_id: int,
    ) -> _ProcessEntry:
        cache = request.cwd
        while cache.name in {"work", "tmp", ".scout-executions"} or cache.parent.name == ".scout-executions":
            cache = cache.parent
        cache = cache / ".scout-cache"
        cache.mkdir(parents=True, exist_ok=True)
        exec_home = cache / "home"
        exec_home.mkdir(parents=True, exist_ok=True)
        env = build_execution_env(home=exec_home, cache_dir=cache)
        env["TERM"] = "xterm-256color"
        env["NO_COLOR"] = "1"
        sandbox_python = request.sandbox_python or resolve_sandbox_python(None)
        env = enrich_execution_env(env, sandbox_python=sandbox_python, cache_dir=cache)

        cmd = ["/bin/sh", "-c", request.command]
        private_tmp = request.staging_dir / "tmp" if request.staging_dir else None
        net: IsolatedNetwork | None = None
        net_mgr: IsolatedNetworkManager | None = None
        effective_proxy = request.proxy_url

        if request.policy.network.mode == "allow_domains" and request.proxy_url:
            if not network_isolation_available():
                raise RuntimeError("Network egress requires isolated network namespace")
            net_mgr = IsolatedNetworkManager(request.proxy_url)
            net = net_mgr.create()
            effective_proxy = net.proxy_url

        launch_cmd: list[str]
        if bwrap_available() and self._probe.isolation:
            bwrap_cmd = build_bwrap_command(
                cmd,
                cwd=request.cwd,
                env=env,
                policy=request.policy,
                private_tmp=private_tmp,
                python_binary=sandbox_python,
                proxy_url=effective_proxy,
                isolated_network=net is not None,
                workspace_root=request.cwd,
            )
            launch_cmd = wrap_command_in_netns(bwrap_cmd, net) if net else bwrap_cmd
        else:
            docker_cmd = self._docker_launch_cmd(request, cmd, env, effective_proxy)
            if docker_cmd:
                launch_cmd = docker_cmd
            elif request.allow_insecure_fallback:
                launch_cmd = cmd
            else:
                raise RuntimeError("Sandbox unavailable for unified exec")

        master, slave = pty.openpty() if request.tty else (None, None)
        if request.tty and master is not None:
            proc = subprocess.Popen(
                launch_cmd,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=str(request.cwd),
                start_new_session=True,
            )
            os.close(slave)
            master_fd = master
        else:
            proc = subprocess.Popen(
                launch_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=str(request.cwd),
                start_new_session=True,
            )
            master_fd = -1

        buffer = HeadTailBuffer(max_bytes=self._config.max_output_bytes)
        entry = _ProcessEntry(
            process_id=process_id,
            user_id=request.user_id,
            session_id=request.session_id,
            execution_id=request.execution_id,
            command=request.command,
            cwd=request.cwd,
            policy=request.policy,
            staging_dir=request.staging_dir,
            work_dir=request.work_dir,
            proc=proc,
            master_fd=master_fd,
            buffer=buffer,
            output_notify=threading.Event(),
            reader_thread=threading.Thread(),
            tool_call_id=request.tool_call_id,
            proxy_url=effective_proxy,
            net=net,
            net_mgr=net_mgr,
        )
        if master_fd >= 0:
            self._start_reader(entry)
        else:
            self._start_pipe_reader(entry)
        return entry

    def _start_pipe_reader(self, entry: _ProcessEntry) -> None:
        def _read() -> None:
            assert entry.proc.stdout is not None
            while True:
                chunk = entry.proc.stdout.read(4096)
                if not chunk:
                    entry.output_notify.set()
                    break
                entry.buffer.append(chunk)
                self._emit_chunk(entry, chunk.decode("utf-8", errors="replace"))
                entry.output_notify.set()

        entry.reader_thread = threading.Thread(target=_read, daemon=True)
        entry.reader_thread.start()

    def _collect_until(self, entry: _ProcessEntry, yield_ms: int) -> bytes:
        deadline = time.time() + yield_ms / 1000.0
        while time.time() < deadline:
            entry.output_notify.wait(timeout=min(0.25, deadline - time.time()))
            entry.output_notify.clear()
            if entry.proc.poll() is not None:
                break
        return entry.buffer.snapshot()

    def _finish_entry(self, entry: _ProcessEntry) -> None:
        with self._lock:
            self._processes.pop(entry.process_id, None)
            scope = self._scoped.get(self._scope_key(entry.user_id, entry.session_id))
            if scope:
                scope.discard(entry.process_id)
        try:
            if entry.proc.poll() is None:
                kill_process_tree(entry.proc.pid)
                drain_process_io(entry.proc)
        except Exception:
            pass
        if entry.master_fd >= 0:
            try:
                os.close(entry.master_fd)
            except OSError:
                pass
        if entry.net and entry.net_mgr:
            entry.net_mgr.destroy(entry.net)

    def exec_command(self, request: UnifiedExecCommandRequest) -> UnifiedExecResponse:
        with self._lock:
            if len(self._processes) >= self._config.max_unified_exec_processes:
                return UnifiedExecResponse(
                    output="",
                    wall_time_seconds=0,
                    error=f"Too many concurrent processes (max {self._config.max_unified_exec_processes})",
                )

        process_id = self._allocate_id()
        start = time.time()
        try:
            entry = self._spawn(request, process_id)
        except Exception as exc:
            return UnifiedExecResponse(
                output="",
                wall_time_seconds=time.time() - start,
                error=str(exc),
            )

        with self._lock:
            self._processes[process_id] = entry
            key = self._scope_key(request.user_id, request.session_id)
            self._scoped.setdefault(key, set()).add(process_id)

        stream_q = self._stream_queues.get(request.execution_id)
        yield_ms = clamp_yield_time(request.yield_time_ms)
        raw = self._collect_until(entry, yield_ms)
        wall = time.time() - start
        text = raw.decode("utf-8", errors="replace")
        exit_code = entry.proc.poll()

        if exit_code is not None:
            entry.reader_thread.join(timeout=1.0)
            self._finish_entry(entry)
            if stream_q is not None:
                stream_q.put(None)
            return UnifiedExecResponse(
                output=format_tool_response(
                    text,
                    wall_time_seconds=wall,
                    exit_code=exit_code,
                    max_output_tokens=request.max_output_tokens,
                ),
                wall_time_seconds=wall,
                exit_code=exit_code,
                chunk_id=str(uuid.uuid4())[:8],
                alive=False,
            )

        return UnifiedExecResponse(
            output=format_tool_response(
                text,
                wall_time_seconds=wall,
                process_id=process_id,
                max_output_tokens=request.max_output_tokens,
            ),
            wall_time_seconds=wall,
            process_id=process_id,
            chunk_id=str(uuid.uuid4())[:8],
            alive=True,
        )

    def write_stdin(self, request: UnifiedExecStdinRequest) -> UnifiedExecResponse:
        with self._lock:
            entry = self._processes.get(request.process_id)
        if entry is None:
            return UnifiedExecResponse(
                output="",
                wall_time_seconds=0,
                error=f"Unknown process id {request.process_id}",
            )
        if entry.user_id != request.user_id or entry.session_id != request.session_id:
            return UnifiedExecResponse(
                output="",
                wall_time_seconds=0,
                error=f"Unknown process id {request.process_id}",
            )

        start = time.time()
        if request.chars and entry.master_fd >= 0:
            try:
                os.write(entry.master_fd, request.chars.encode("utf-8"))
                time.sleep(0.1)
            except OSError as exc:
                self._finish_entry(entry)
                return UnifiedExecResponse(
                    output="",
                    wall_time_seconds=time.time() - start,
                    error=f"write_stdin failed: {exc}",
                )

        empty_poll = not request.chars
        yield_ms = clamp_yield_time(
            request.yield_time_ms,
            empty_poll=empty_poll,
            max_poll_ms=self._config.max_background_poll_ms,
        )
        raw = self._collect_until(entry, yield_ms)
        wall = time.time() - start
        text = raw.decode("utf-8", errors="replace")
        exit_code = entry.proc.poll()
        max_tokens = request.max_output_tokens

        if exit_code is not None:
            entry.reader_thread.join(timeout=1.0)
            exec_id = entry.execution_id
            self._finish_entry(entry)
            stream_q = self._stream_queues.get(exec_id)
            if stream_q is not None:
                stream_q.put(None)
            return UnifiedExecResponse(
                output=format_tool_response(
                    text,
                    wall_time_seconds=wall,
                    exit_code=exit_code,
                    max_output_tokens=max_tokens,
                ),
                wall_time_seconds=wall,
                exit_code=exit_code,
                chunk_id=str(uuid.uuid4())[:8],
                alive=False,
            )

        return UnifiedExecResponse(
            output=format_tool_response(
                text,
                wall_time_seconds=wall,
                process_id=request.process_id,
                max_output_tokens=max_tokens,
            ),
            wall_time_seconds=wall,
            process_id=request.process_id,
            chunk_id=str(uuid.uuid4())[:8],
            alive=True,
        )

    def get_entry(self, process_id: int) -> _ProcessEntry | None:
        with self._lock:
            return self._processes.get(process_id)

    def close_session(self, session_id: str) -> None:
        with self._lock:
            to_close = [
                e for e in self._processes.values()
                if e.session_id == session_id
            ]
        for entry in to_close:
            self._finish_entry(entry)

    def close_all(self) -> None:
        with self._lock:
            entries = list(self._processes.values())
        for entry in entries:
            self._finish_entry(entry)


def format_tool_response(
    output: str,
    *,
    wall_time_seconds: float,
    process_id: int | None = None,
    exit_code: int | None = None,
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
) -> str:
    sections: list[str] = []
    sections.append(f"Wall time: {wall_time_seconds:.4f} seconds")
    if exit_code is not None:
        sections.append(f"Process exited with code {exit_code}")
    if process_id is not None:
        sections.append(f"Process running with session ID {process_id}")
    sections.append(f"Original token count: {approx_token_count(output)}")
    sections.append("Output:")
    sections.append(truncate_text(output, max_output_tokens))
    return "\n".join(sections)


async def run_in_executor(fn, *args):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, fn, *args)
