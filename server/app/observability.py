"""Observability wiring (fleet-obs → Phoenix), with a no-op fallback.

Mirrors the agentic-os gateway pattern: tracing must NEVER break a request, so
every path degrades to a no-op. Set ``FLEET_OBS_DISABLE=1`` (tests/CI/offline)
to skip it entirely. fleet-obs auto-registers OTLP → Phoenix
(``PHOENIX_COLLECTOR_ENDPOINT``, default the cosmos tailnet).
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import Any

log = logging.getLogger("excaliboard")

_tracer: Any = None


@contextmanager
def _noop_span() -> Any:
    yield None


class _NoopTracer:
    def start_as_current_span(self, *_args: Any, **_kwargs: Any) -> Any:
        return _noop_span()


def tracer() -> Any:
    """Process-wide tracer; initialized once, no-op on any failure."""
    global _tracer
    if _tracer is None:
        if os.getenv("FLEET_OBS_DISABLE") == "1":
            _tracer = _NoopTracer()
        else:
            try:
                from fleet_obs import observe

                _tracer = observe("excaliboard-sync")
            except Exception as e:  # noqa: BLE001 — tracing must never break boot
                log.warning("tracing disabled (fleet-obs unavailable): %s", e)
                _tracer = _NoopTracer()
    return _tracer


def instrument_app(app: Any) -> None:
    """Best-effort HTTP-span instrumentation; silent if OTEL isn't installed."""
    if os.getenv("FLEET_OBS_DISABLE") == "1":
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app)
    except Exception as e:  # noqa: BLE001
        log.info("FastAPI OTEL instrumentation unavailable: %s", e)
