"""Load and validate YAML configuration into Pydantic settings.

The config model uses ``extra="allow"`` on the top-level ``AppConfig``
so that project-specific fields (e.g. ``hierarchy``, ``geo_columns``)
pass through without validation errors.
"""

from __future__ import annotations

from pathlib import Path
import hashlib
from typing import Any

import yaml
from pydantic import BaseModel, Field, model_validator
from .secrets import load_secret


# ── Leaf-level config models ────────────────────────────────────────────────


class PDFConfig(BaseModel):
    """PDF conversion settings."""

    parser: str = Field(
        "pdfplumber",
        description=(
            "PDF parser backend. "
            "'pdfplumber' – heuristic table extraction + pymupdf prose, fast & lightweight. "
            "'docling'    – ML-based (IBM TableFormer), best table quality, slower."
        ),
    )


class RetrieverConfig(BaseModel):
    """BM25 retriever settings."""

    top_k: int = 5
    chunk_size: int = 1000   # characters (used by RecursiveCharacterTextSplitter)
    chunk_overlap: int = 200


class CSVSourceConfig(BaseModel):
    """Per-file configuration for an auxiliary CSV in data/csv_files/."""

    geo_columns: dict[str, str] = Field(
        default_factory=dict,
        description="Mapping of admin level -> column name (e.g. {state: 'State Name'})",
    )
    text_search_columns: list[str] = Field(
        default_factory=list,
        description="Columns to text-search for location mentions",
    )
    description: str = ""


class MemoriesConfig(BaseModel):
    """Codex-style memory pipeline settings."""

    use_memories: bool = True
    generate_memories: bool = True
    max_summary_tokens: int = 4000
    stage1_scan_limit: int = 32
    stage1_max_jobs_per_startup: int = 4
    stage1_concurrency: int = 4
    stage1_idle_hours: float = 1.0
    stage1_max_age_days: int = 30
    stage1_retry_backoff_seconds: int = 3600
    phase2_top_n: int = 50
    max_unused_days: int = 90


class SkillsConfig(BaseModel):
    """Skill loading settings."""

    defer_loading: bool = True


class PermissionsConfig(BaseModel):
    """Runtime permission elevation settings."""

    allow_request_permissions: bool = True


class HooksConfig(BaseModel):
    """Lifecycle hook settings."""

    enabled: bool = True


class SessionTitlesConfig(BaseModel):
    """Automatic conversation title settings."""

    enabled: bool = True
    timeout_seconds: int = Field(60, ge=1)
    max_attempts: int = Field(2, ge=1, le=5)
    model: str | None = None


class ExecutionConfig(BaseModel):
    """Execution sandbox settings."""

    enabled: bool = True
    backend: str = Field(
        "auto",
        description="local-sandbox | worker | container | disabled | auto",
    )
    isolation: str = Field(
        default_factory=lambda: __import__("os").environ.get(
            "SCOUT_EXECUTION_ISOLATION", "auto"
        ),
        description=(
            "Worker-internal isolation mechanism: container | bwrap | auto. "
            "'auto' prefers per-session sandbox containers when a container "
            "engine is reachable, else falls back to bubblewrap."
        ),
    )
    require_isolation: bool = True
    network_default: str = Field("deny", description="deny | allow_domains")
    timeout_seconds: int = 60
    max_output_bytes: int = 100_000
    max_memory_mb: int = 1024
    max_processes: int = 64
    persistent_python: bool = True
    allow_insecure_local_fallback: bool = False
    unified_shell: bool = True
    default_yield_time_ms: int = 10_000
    max_background_poll_ms: int = 300_000
    max_unified_exec_processes: int = 64
    worker_url: str = Field(
        default_factory=lambda: __import__("os").environ.get(
            "SCOUT_WORKER_URL", "http://127.0.0.1:7891"
        ),
    )


class AgentConfig(BaseModel):
    """Settings for the agentic (conversational) mode."""

    model: str = Field(
        "groq/llama-3.1-8b-instant",
        description="LiteLLM model string (e.g. 'groq/llama-3.1-8b-instant').",
    )
    disable_write_tools: bool = Field(
        False, 
        description="When true, the agent cannot write to files. Prevents hallucinations in read-only setups."
    )
    permission_profile: str = Field(
        "contributor",
        description="Named permission preset: analyst, contributor, or admin.",
    )
    temperature: float = 1.0
    max_iterations: int = Field(
        15, description="Max tool-calling rounds per user turn."
    )
    context_compress_threshold: float = Field(
        0.80,
        description=(
            "Fraction of the model's context window that triggers "
            "automatic compression (0.0–1.0).  Uses litellm.token_counter "
            "and litellm.get_model_info to measure."
        ),
    )
    compress_keep_recent: int = Field(
        10,
        description="Number of recent messages to keep verbatim during compression.",
    )
    conda_env: str = Field(
        "agents",
        description="Conda environment used for the persistent code session.",
    )
    python_path: str | None = Field(
        None,
        description=(
            "Absolute path to a Python binary (e.g. from a venv). "
            "When set, takes priority over conda_env."
        ),
    )
    code_timeout: int = Field(
        30, description="Seconds before a code block is killed."
    )
    bad_request_retries: int = Field(
        2,
        description=(
            "Number of retries when the LLM produces a malformed tool call "
            "(BadRequestError). After exhausting retries, the original "
            "request is retried without tools."
        ),
    )


class JSONSourceConfig(BaseModel):
    """Per-file configuration for a JSON file in data/json_files/.

    Only files listed in ``json_sources`` are indexed by BM25.
    """

    context_fields: list[str] = Field(
        ...,
        description=(
            "Fields whose text is combined into a single searchable "
            "document per record (avoids double-counting in BM25)."
        ),
    )
    metadata_fields: list[str] = Field(
        default_factory=list,
        description=(
            "Fields shown as structured metadata for the LLM. "
            "If empty, all non-context fields become metadata."
        ),
    )
    description: str = ""


# ── LLM provider config ─────────────────────────────────────────────────────


class LLMProviderConfig(BaseModel):
    """Configuration for a single LLM provider (e.g. groq, openai)."""

    api_key: str = ""
    api_base: str | None = None
    models: list[str] = Field(default_factory=list)


class LLMConfig(BaseModel):
    """Aggregated LLM provider configuration."""

    providers: dict[str, LLMProviderConfig] = Field(default_factory=dict)

    def get_all_models(self) -> list[str]:
        """Return all models from every provider that has an api_key."""
        import os
        models: list[str] = []
        
        provider_names = set(self.providers.keys())
        for env_var in os.environ:
            if env_var.endswith("_API_KEY"):
                name = env_var[:-8].lower()
                provider_names.add(name)

        for name in provider_names:
            prov = self.providers.get(name, LLMProviderConfig())
            api_key = prov.api_key or load_secret(f"{name.upper()}_API_KEY")
            if api_key:
                env_models = os.environ.get(f"{name.upper()}_MODELS")
                if env_models:
                    models.extend([m.strip() for m in env_models.split(",") if m.strip()])
                else:
                    models.extend(prov.models)
        
        # Remove duplicates while preserving order
        return list(dict.fromkeys(models))

    def inject_env_vars(self) -> None:
        """Inject provider API keys / bases into ``os.environ``."""
        import os

        for name, prov in self.providers.items():
            api_key = prov.api_key or load_secret(f"{name.upper()}_API_KEY")
            if api_key:
                os.environ.setdefault(f"{name.upper()}_API_KEY", api_key)
            if prov.api_base:
                os.environ.setdefault(f"{name.upper()}_API_BASE", prov.api_base)


# ── Top-level config ────────────────────────────────────────────────────────


class AppConfig(BaseModel):
    """Top-level application configuration.

    Uses ``extra="allow"`` so that project-specific fields (e.g.
    ``hierarchy``, ``geo_columns``, ``feature_selection``)
    pass through without validation errors. This lets the generic
    Scout framework carry domain-specific config alongside its own.
    """

    model_config = {"extra": "allow", "arbitrary_types_allowed": True}

    # Raw paths as written in YAML (relative to config dir)
    data_paths: dict[str, str] = Field(default_factory=dict)

    retriever: RetrieverConfig = Field(default_factory=RetrieverConfig)
    pdf: PDFConfig = Field(default_factory=PDFConfig)
    csv_sources: dict[str, CSVSourceConfig] = Field(default_factory=dict)
    json_sources: dict[str, JSONSourceConfig] = Field(default_factory=dict)
    agent: AgentConfig = Field(default_factory=AgentConfig)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    memories: MemoriesConfig = Field(default_factory=MemoriesConfig)
    skills: SkillsConfig = Field(default_factory=SkillsConfig)
    permissions: PermissionsConfig = Field(default_factory=PermissionsConfig)
    hooks: HooksConfig = Field(default_factory=HooksConfig)
    session_titles: SessionTitlesConfig = Field(default_factory=SessionTitlesConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)

    # Resolved absolute paths (populated after validation)
    _resolved_paths: dict[str, Path] = {}
    _config_dir: Path = Path(".")

    @model_validator(mode="after")
    def _resolve_paths(self) -> "AppConfig":
        """Resolve relative data_paths against the config file directory."""
        resolved: dict[str, Path] = {}
        for key, rel in self.data_paths.items():
            p = Path(rel)
            if not p.is_absolute():
                p = (self._config_dir / p).resolve()
            resolved[key] = p
        self._resolved_paths = resolved
        return self

    # Convenience accessors for resolved paths
    def get_path(self, key: str) -> Path:
        """Return the resolved absolute path for a data_paths key."""
        return self._resolved_paths[key]


# ── Helpers ─────────────────────────────────────────────────────────────────


_XDG_CONFIG = Path.home() / ".config" / "scout"
GLOBAL_CONFIG_PATH = _XDG_CONFIG / "config.yaml"
SECRET_FIELDS = {"api_key", "secret", "password", "token"}


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge *override* into *base* (override wins)."""
    merged = dict(base)
    for key, val in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(val, dict):
            merged[key] = _deep_merge(merged[key], val)
        else:
            merged[key] = val
    return merged


# ── Loader ──────────────────────────────────────────────────────────────────


def load_config(
    config_path: str | Path | None = None,
    *,
    cwd: str | Path | None = None,
) -> AppConfig:
    """Load a YAML config file and return a validated AppConfig.

    Resolution order:
    1. Global config (``~/.config/scout/config.yaml``) — base layer
    2. Project config (*config_path*) — overrides global (if provided)

    When *config_path* is ``None`` the agent starts with global
    config + defaults only (no project file required).

    *cwd* sets the base directory for resolving relative ``data_paths``
    entries.  Defaults to the config file's parent directory, or
    ``os.getcwd()`` when no config file is given.
    """
    import os as _os

    # Base: global config (if exists)
    raw: dict[str, Any] = {}
    if GLOBAL_CONFIG_PATH.exists():
        with open(GLOBAL_CONFIG_PATH, "r") as f:
            global_raw = yaml.safe_load(f) or {}
        raw = global_raw

    # Override: project config (if provided)
    resolved_config: Path | None = None
    if config_path is not None:
        resolved_config = Path(config_path).resolve()
        with open(resolved_config, "r") as f:
            project_raw: dict[str, Any] = yaml.safe_load(f) or {}
        raw = _deep_merge(raw, project_raw)

    config = AppConfig(**raw)

    # Determine the base directory for resolving relative paths
    if cwd is not None:
        base_dir = Path(cwd).resolve()
    elif resolved_config is not None:
        base_dir = resolved_config.parent
    else:
        base_dir = Path(_os.getcwd())

    object.__setattr__(config, "_config_dir", base_dir)
    config._resolve_paths()
    return config


def load_deployment_config(config_path: str | Path, *, cwd: str | Path | None = None) -> AppConfig:
    """Load a strict operator-managed deployment config without global overrides."""
    path = Path(config_path).resolve()
    with open(path, "rb") as f:
        content = f.read()
    raw = yaml.safe_load(content) or {}
    known = set(AppConfig.model_fields)
    unknown = sorted(set(raw) - known)
    if unknown:
        raise ValueError(f"Unknown deployment config section(s): {', '.join(unknown)}")
    config = AppConfig(**raw)
    base_dir = Path(cwd).resolve() if cwd is not None else path.parent
    object.__setattr__(config, "_config_dir", base_dir)
    config._resolve_paths()
    return config


def config_hash(config: AppConfig) -> str:
    payload = yaml.safe_dump(config.model_dump(mode="json"), sort_keys=True).encode()
    return hashlib.sha256(payload).hexdigest()[:16]


def redacted_config(config: AppConfig) -> dict[str, Any]:
    def redact(value: Any, key: str = "") -> Any:
        if any(part in key.lower() for part in SECRET_FIELDS):
            return "[REDACTED]" if value else ""
        if isinstance(value, dict):
            return {k: redact(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [redact(v) for v in value]
        return value
    return redact(config.model_dump(mode="json"))
