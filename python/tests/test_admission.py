import asyncio

import pytest

from scout.server.admission import (
    AdmissionPolicy,
    AdmissionRejected,
    AdmissionTimedOut,
    AgentTurnScheduler,
)


def scheduler(**overrides) -> AgentTurnScheduler:
    settings = {
        "max_concurrent": 2,
        "max_queued": 8,
        "max_queued_per_user": 4,
        "queue_timeout_seconds": 1,
        "priority_aging_seconds": 10,
    }
    settings.update(overrides)
    return AgentTurnScheduler(**settings)


@pytest.mark.asyncio
async def test_never_exceeds_global_or_per_user_limits():
    turns = scheduler(max_concurrent=3)
    policy = AdmissionPolicy(max_concurrent=2)
    first = await turns.acquire("alice", policy)
    second = await turns.acquire("alice", policy)
    blocked = asyncio.create_task(turns.acquire("alice", policy))
    bob = await turns.acquire("bob", policy)
    await asyncio.sleep(0)

    snapshot = await turns.snapshot()
    assert snapshot["active_requests"] == 3
    assert not blocked.done()

    await first.release()
    third = await blocked
    await asyncio.gather(second.release(), bob.release(), third.release())
    assert (await turns.snapshot())["active_requests"] == 0


@pytest.mark.asyncio
async def test_runtime_reconfiguration_preserves_active_leases():
    turns = scheduler(max_concurrent=1)
    first = await turns.acquire("alice", AdmissionPolicy())
    waiting = asyncio.create_task(turns.acquire("bob", AdmissionPolicy()))
    await asyncio.sleep(0)
    await turns.reconfigure(
        max_concurrent=2,
        max_queued=10,
        max_queued_per_user=5,
        queue_timeout_seconds=2,
        priority_aging_seconds=5,
    )
    second = await waiting
    assert (await turns.snapshot())["active_requests"] == 2
    await first.release()
    await second.release()


@pytest.mark.asyncio
async def test_priority_preference_and_fifo_within_priority():
    turns = scheduler(max_concurrent=1)
    running = await turns.acquire("running", AdmissionPolicy())
    order: list[str] = []

    async def wait(user: str, priority: int):
        lease = await turns.acquire(user, AdmissionPolicy(priority=priority))
        order.append(user)
        await lease.release()

    standard_one = asyncio.create_task(wait("standard-one", 0))
    standard_two = asyncio.create_task(wait("standard-two", 0))
    preferred = asyncio.create_task(wait("preferred", 1))
    await asyncio.sleep(0)
    await running.release()
    await asyncio.gather(standard_one, standard_two, preferred)

    assert order == ["preferred", "standard-one", "standard-two"]


@pytest.mark.asyncio
async def test_aging_prevents_lower_priority_starvation():
    now = [0.0]
    turns = scheduler(max_concurrent=1, priority_aging_seconds=5, clock=lambda: now[0])
    running = await turns.acquire("running", AdmissionPolicy())
    old_standard = asyncio.create_task(turns.acquire("standard", AdmissionPolicy(priority=0)))
    await asyncio.sleep(0)
    now[0] = 11.0
    newer_priority = asyncio.create_task(turns.acquire("priority", AdmissionPolicy(priority=1)))
    await asyncio.sleep(0)
    await running.release()

    standard_lease = await old_standard
    assert not newer_priority.done()
    await standard_lease.release()
    priority_lease = await newer_priority
    await priority_lease.release()


@pytest.mark.asyncio
async def test_queue_bounds_and_helpful_timeout_signal():
    turns = scheduler(
        max_concurrent=1,
        max_queued=1,
        max_queued_per_user=1,
        queue_timeout_seconds=0.01,
    )
    running = await turns.acquire("running", AdmissionPolicy())
    waiting = asyncio.create_task(turns.acquire("alice", AdmissionPolicy()))
    await asyncio.sleep(0)
    with pytest.raises(AdmissionRejected):
        await turns.acquire("bob", AdmissionPolicy())
    with pytest.raises(AdmissionTimedOut):
        await waiting
    await running.release()


@pytest.mark.asyncio
async def test_cancelled_waiter_is_removed_and_lease_release_is_idempotent():
    turns = scheduler(max_concurrent=1)
    running = await turns.acquire("running", AdmissionPolicy())
    waiting = asyncio.create_task(turns.acquire("alice", AdmissionPolicy()))
    await asyncio.sleep(0)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    assert (await turns.snapshot())["queued_requests"] == 0
    await running.release()
    await running.release()
    assert (await turns.snapshot())["active_requests"] == 0
