import asyncio
import threading

import pytest

from scout.execution.service import ExecutionService


class FakeBackend:
    def set_output_chunk_callback(self, callback):
        self.callback = callback


@pytest.mark.asyncio
async def test_threaded_output_delivery_is_bounded_and_loop_safe():
    service = object.__new__(ExecutionService)
    service._backend = FakeBackend()
    service._active_tool_call_id = "fallback-tool"
    service._output_sink = None
    service._output_loop = None
    service._output_schedule_slots = threading.BoundedSemaphore(256)
    service._wire_chunk_callback()
    sink = asyncio.Queue(maxsize=32)
    service.set_output_sink(sink)

    producer = threading.Thread(
        target=lambda: [
            service._backend.callback("tool-1", 7, f"chunk-{index}")
            for index in range(2000)
        ]
    )
    producer.start()
    while producer.is_alive():
        await asyncio.sleep(0)
    producer.join()
    await asyncio.sleep(0.01)

    assert 0 < sink.qsize() <= sink.maxsize
    event = sink.get_nowait()
    assert event["tool_call_id"] == "tool-1"
    assert event["process_id"] == 7
    service.set_output_sink(None)
