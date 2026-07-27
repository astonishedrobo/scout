"""Fair, priority-aware admission control for expensive agent turns."""

from __future__ import annotations

import asyncio
import itertools
import time
from dataclasses import dataclass
from typing import Callable


class AdmissionRejected(Exception):
    """Raised when the bounded waiting room cannot accept another turn."""


class AdmissionTimedOut(Exception):
    """Raised when a queued turn waits longer than the configured deadline."""


@dataclass(frozen=True)
class AdmissionPolicy:
    priority: int = 0
    max_concurrent: int = 4


@dataclass
class _Waiter:
    user_id: str
    policy: AdmissionPolicy
    enqueued_at: float
    sequence: int
    future: asyncio.Future["AdmissionLease"]


class AdmissionLease:
    """Idempotent async lease returned for an admitted agent turn."""

    def __init__(self, scheduler: "AgentTurnScheduler", user_id: str) -> None:
        self._scheduler = scheduler
        self.user_id = user_id
        self._released = False

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        await self._scheduler._release(self.user_id)

    async def __aenter__(self) -> "AdmissionLease":
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.release()


class AgentTurnScheduler:
    """Bounded, work-conserving scheduler with aging and per-user fairness.

    Priority determines preference, while aging raises a waiter's effective
    priority over time so lower-priority users cannot starve indefinitely.
    Among otherwise equal candidates, users with fewer active turns are chosen
    first and FIFO sequence is the final tie-breaker.
    """

    def __init__(
        self,
        *,
        max_concurrent: int,
        max_queued: int,
        max_queued_per_user: int,
        queue_timeout_seconds: float,
        priority_aging_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_concurrent = max_concurrent
        self.max_queued = max_queued
        self.max_queued_per_user = max_queued_per_user
        self.queue_timeout_seconds = queue_timeout_seconds
        self.priority_aging_seconds = priority_aging_seconds
        self._clock = clock
        self._lock = asyncio.Lock()
        self._waiters: list[_Waiter] = []
        self._active_by_user: dict[str, int] = {}
        self._active = 0
        self._sequence = itertools.count()
        self._admitted_total = 0
        self._rejected_total = 0
        self._timed_out_total = 0
        self._queue_wait_seconds_total = 0.0

    async def acquire(self, user_id: str, policy: AdmissionPolicy) -> AdmissionLease:
        user_id = str(user_id)
        loop = asyncio.get_running_loop()
        async with self._lock:
            queued_for_user = sum(w.user_id == user_id for w in self._waiters)
            must_queue = bool(self._waiters) or self._active >= self.max_concurrent or (
                self._active_by_user.get(user_id, 0) >= policy.max_concurrent
            )
            if must_queue and (
                len(self._waiters) >= self.max_queued
                or queued_for_user >= self.max_queued_per_user
            ):
                self._rejected_total += 1
                raise AdmissionRejected
            waiter = _Waiter(
                user_id=user_id,
                policy=policy,
                enqueued_at=self._clock(),
                sequence=next(self._sequence),
                future=loop.create_future(),
            )
            self._waiters.append(waiter)
            self._dispatch_locked()

        try:
            return await asyncio.wait_for(
                asyncio.shield(waiter.future),
                timeout=self.queue_timeout_seconds,
            )
        except TimeoutError as exc:
            async with self._lock:
                if waiter in self._waiters:
                    self._waiters.remove(waiter)
                    waiter.future.cancel()
                    self._timed_out_total += 1
                    raise AdmissionTimedOut from exc
            # Admission won the timeout race. Recover and immediately release
            # the slot instead of leaking global capacity.
            if waiter.future.done() and not waiter.future.cancelled():
                await waiter.future.result().release()
            raise AdmissionTimedOut from exc
        except asyncio.CancelledError:
            admitted_lease: AdmissionLease | None = None
            async with self._lock:
                if waiter in self._waiters:
                    self._waiters.remove(waiter)
                    waiter.future.cancel()
                elif waiter.future.done() and not waiter.future.cancelled():
                    admitted_lease = waiter.future.result()
            if admitted_lease is not None:
                await admitted_lease.release()
            raise

    def _dispatch_locked(self) -> None:
        while self._active < self.max_concurrent:
            eligible = [
                waiter for waiter in self._waiters
                if self._active_by_user.get(waiter.user_id, 0) < waiter.policy.max_concurrent
            ]
            if not eligible:
                return
            now = self._clock()

            def rank(waiter: _Waiter) -> tuple[int, int, int]:
                age_bonus = int((now - waiter.enqueued_at) / self.priority_aging_seconds)
                return (
                    waiter.policy.priority + age_bonus,
                    -self._active_by_user.get(waiter.user_id, 0),
                    -waiter.sequence,
                )

            selected = max(eligible, key=rank)
            self._waiters.remove(selected)
            self._active += 1
            self._active_by_user[selected.user_id] = self._active_by_user.get(selected.user_id, 0) + 1
            self._admitted_total += 1
            self._queue_wait_seconds_total += max(0.0, now - selected.enqueued_at)
            selected.future.set_result(AdmissionLease(self, selected.user_id))

    async def _release(self, user_id: str) -> None:
        async with self._lock:
            current = self._active_by_user.get(user_id, 0)
            if current <= 1:
                self._active_by_user.pop(user_id, None)
            else:
                self._active_by_user[user_id] = current - 1
            self._active = max(0, self._active - 1)
            self._dispatch_locked()

    async def snapshot(self) -> dict:
        async with self._lock:
            now = self._clock()
            queued_by_user: dict[str, int] = {}
            for waiter in self._waiters:
                queued_by_user[waiter.user_id] = queued_by_user.get(waiter.user_id, 0) + 1
            return {
                "active_requests": self._active,
                "max_concurrent_requests": self.max_concurrent,
                "queued_requests": len(self._waiters),
                "queued_users": len({w.user_id for w in self._waiters}),
                # The configured limits travel with the counters they bound.
                # Without them a reader can show "3 queued" but not whether that
                # is idle or nearly full, which is the only useful question.
                "max_queued": self.max_queued,
                "max_queued_per_user": self.max_queued_per_user,
                "queue_timeout_seconds": self.queue_timeout_seconds,
                "priority_aging_seconds": self.priority_aging_seconds,
                # Per-user breakdowns, copied out under the lock.
                "active_by_user": dict(self._active_by_user),
                "queued_by_user": queued_by_user,
                "oldest_queue_age_seconds": round(
                    max((now - w.enqueued_at for w in self._waiters), default=0.0), 3
                ),
                "admitted_requests_total": self._admitted_total,
                "rejected_requests_total": self._rejected_total,
                "timed_out_requests_total": self._timed_out_total,
                "average_queue_wait_seconds": round(
                    self._queue_wait_seconds_total / self._admitted_total
                    if self._admitted_total else 0.0,
                    3,
                ),
            }

    async def reconfigure(
        self,
        *,
        max_concurrent: int,
        max_queued: int,
        max_queued_per_user: int,
        queue_timeout_seconds: float,
        priority_aging_seconds: float,
    ) -> None:
        """Apply safe runtime limit changes without invalidating active leases."""
        async with self._lock:
            self.max_concurrent = max_concurrent
            self.max_queued = max_queued
            self.max_queued_per_user = max_queued_per_user
            self.queue_timeout_seconds = queue_timeout_seconds
            self.priority_aging_seconds = priority_aging_seconds
            self._dispatch_locked()
