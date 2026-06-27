"""Admin CLI fallback: promote or list users.

    python -m app.admin grant <email>
    python -m app.admin list

Operates on the configured store (DATABASE_URL). Note: with the in-memory store
this runs in its own process, so use it against a real Postgres deploy.
"""

from __future__ import annotations

import asyncio
import sys

from .config import Settings
from .main import _build_store


async def _grant(email: str) -> None:
    store = _build_store(Settings())
    await store.startup()
    try:
        ok = await store.grant_admin_by_email(email)
        print(f"{'granted admin to' if ok else 'no such user:'} {email}")
    finally:
        await store.shutdown()


async def _list() -> None:
    store = _build_store(Settings())
    await store.startup()
    try:
        for u, count in await store.list_users():
            print(
                f"{(u.email or '(no email)'):40} role={u.role:5} "
                f"verified={u.email_verified!s:5} disabled={u.disabled!s:5} boards={count}"
            )
    finally:
        await store.shutdown()


def main() -> None:
    args = sys.argv[1:]
    if len(args) >= 2 and args[0] == "grant":
        asyncio.run(_grant(args[1]))
    elif args and args[0] == "list":
        asyncio.run(_list())
    else:
        print("usage: python -m app.admin grant <email> | list")
        sys.exit(2)


if __name__ == "__main__":
    main()
