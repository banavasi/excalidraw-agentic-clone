"""Tiny in-process sliding-window rate limiter (per-process, best-effort).

Bounds brute-force on the auth endpoints. Single-process is enough for a
self-host / one cosmos container; a multi-replica deploy would swap this for
Redis (YAGNI for v1). ``allow`` returns False when the key is over its limit.
"""

from __future__ import annotations

import time


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str, limit: int, window_seconds: int) -> bool:
        now = time.time()
        cutoff = now - window_seconds
        bucket = [t for t in self._hits.get(key, []) if t > cutoff]
        if len(bucket) >= limit:
            self._hits[key] = bucket
            return False
        bucket.append(now)
        self._hits[key] = bucket
        return True
