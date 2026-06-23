import asyncio

from tests.util import IV, b


def _scene(v: int, payload: bytes) -> dict:
    return {"base_version": 0, "scene_version": v, "iv": IV, "ciphertext": b(payload)}


async def test_index_lists_and_sorts_ascending(client):
    await client.put("/sync/boards/a", json=_scene(1, b"a"))
    await client.put("/sync/boards/c", json=_scene(1, b"c"))
    idx = (await client.get("/sync/index")).json()
    assert {r["board_id"] for r in idx} == {"a", "c"}
    ups = [r["updated_at"] for r in idx]
    assert ups == sorted(ups)


async def test_index_since_is_inclusive_and_excludes_strictly_older(client):
    # Three boards at increasing wall-clock ms.
    await client.put("/sync/boards/old", json=_scene(1, b"o"))
    await asyncio.sleep(0.02)
    await client.put("/sync/boards/mid", json=_scene(1, b"m"))
    idx = (await client.get("/sync/index")).json()
    mid_cursor = next(r["updated_at"] for r in idx if r["board_id"] == "mid")
    await asyncio.sleep(0.02)
    await client.put("/sync/boards/new", json=_scene(1, b"n"))

    filtered = (await client.get(f"/sync/index?since={mid_cursor}")).json()
    ids = {r["board_id"] for r in filtered}
    assert "old" not in ids  # strictly older than the cursor -> excluded
    assert "mid" in ids  # == cursor -> INCLUSIVE (client de-dupes; never missed)
    assert "new" in ids  # newer -> included


async def test_delete_tombstone_propagates_in_index(client):
    await client.put("/sync/boards/td", json=_scene(1, b"x"))
    d = await client.delete("/sync/boards/td")
    assert d.status_code == 200
    assert d.json() == {"deleted": True}

    idx = (await client.get("/sync/index")).json()
    row = next(r for r in idx if r["board_id"] == "td")
    assert row["deleted"] is True  # other devices learn of the removal

    # The scene itself is no longer pullable.
    g = await client.get("/sync/boards/td")
    assert g.status_code == 404


async def test_delete_missing_board_404(client):
    d = await client.delete("/sync/boards/ghost")
    assert d.status_code == 404
