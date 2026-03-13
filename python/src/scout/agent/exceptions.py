"""Exceptions raised by the agent layer."""

from __future__ import annotations


class ProviderRateLimitError(Exception):
    """The LLM provider returned a rate-limit / quota error.

    This is **not** a bug — it means the provider's TPM / RPM quota was
    exceeded.  The conversation history is intact; the caller can retry
    after the cooldown window.

    Attributes
    ----------
    provider_message : str
        The raw error string from the provider (for logging / display).
    retry_after : float | None
        Seconds to wait before retrying, if the provider supplied this.
    """

    def __init__(
        self,
        provider_message: str,
        *,
        retry_after: float | None = None,
    ) -> None:
        self.provider_message = provider_message
        self.retry_after = retry_after
        human_msg = (
            "Rate limit reached — your API provider's token quota has been "
            "exceeded.  Your conversation history is preserved; please wait "
            "a moment and try again."
        )
        if retry_after is not None:
            human_msg += f"  (retry after ~{retry_after:.0f}s)"
        super().__init__(human_msg)
