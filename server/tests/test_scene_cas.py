from tests.util import IV, b, ub


async def test_create_and_pull(client):
    r = await client.put(
        "/sync/boards/board-1",
        json={"base_version": 0, "scene_version": 3, "iv": IV, "ciphertext": b(b"cipher-A")},
    )
    assert r.status_code == 200
    assert r.json() == {"scene_version": 3}

    g = await client.get("/sync/boards/board-1")
    assert g.status_code == 200
    body = g.json()
    assert body["scene_version"] == 3
    assert ub(body["ciphertext"]) == b"cipher-A"
    assert ub(body["iv"]) == b"\x00" * 12


async def test_get_missing_board_404(client):
    r = await client.get("/sync/boards/does-not-exist")
    assert r.status_code == 404


async def test_cas_conflict_then_reconcile_retry(client):
    # Create at version 1.
    await client.put(
        "/sync/boards/b",
        json={"base_version": 0, "scene_version": 1, "iv": IV, "ciphertext": b(b"v1")},
    )
    # Client B pushes based on 1 -> accepted, now version 2.
    rb = await client.put(
        "/sync/boards/b",
        json={"base_version": 1, "scene_version": 2, "iv": IV, "ciphertext": b(b"v2-B")},
    )
    assert rb.status_code == 200

    # Client A is stale (also based on 1) -> 409 with the current server scene.
    ra = await client.put(
        "/sync/boards/b",
        json={"base_version": 1, "scene_version": 2, "iv": IV, "ciphertext": b(b"v2-A")},
    )
    assert ra.status_code == 409
    conflict = ra.json()
    assert conflict["scene_version"] == 2
    assert ub(conflict["ciphertext"]) == b"v2-B"  # server returns B's winning scene

    # A reconciles locally then retries based on the now-current version (2).
    ra2 = await client.put(
        "/sync/boards/b",
        json={"base_version": 2, "scene_version": 3, "iv": IV, "ciphertext": b(b"v3-merged")},
    )
    assert ra2.status_code == 200
    g = await client.get("/sync/boards/b")
    assert ub(g.json()["ciphertext"]) == b"v3-merged"


async def test_name_rides_along_on_push(client):
    await client.put(
        "/sync/boards/named",
        json={
            "base_version": 0,
            "scene_version": 1,
            "iv": IV,
            "ciphertext": b(b"x"),
            "name_iv": IV,
            "name_ct": b(b"enc-name"),
        },
    )
    idx = (await client.get("/sync/index")).json()
    row = next(r for r in idx if r["board_id"] == "named")
    assert ub(row["name_ct"]) == b"enc-name"


async def test_board_without_scene_recreates_not_crashes():
    # Guards the 409 branch: a board row without a scene row must not 500/KeyError.
    from app.store.base import Blob, PushAccepted
    from app.store.memory import InMemoryStore

    store = InMemoryStore()
    uid = await store.ensure_user("u")
    store._boards[(uid, "x")] = {
        "name_iv": None,
        "name_ct": None,
        "scene_version": 5,
        "deleted": False,
        "updated_at": 1,
    }
    # Mismatched base would normally conflict, but there is no scene to return ->
    # fall through and (re)create the scene instead of dereferencing None.
    res = await store.push_scene(uid, "x", 0, 6, Blob(b"\x00" * 12, b"data"))
    assert isinstance(res, PushAccepted)
    sc = await store.get_scene(uid, "x")
    assert sc is not None and sc.ciphertext == b"data"


async def test_push_undeletes_board(client):
    await client.put(
        "/sync/boards/resurrect",
        json={"base_version": 0, "scene_version": 1, "iv": IV, "ciphertext": b(b"x")},
    )
    await client.delete("/sync/boards/resurrect")
    # An edit after a delete resurrects the board (last-writer wins).
    r = await client.put(
        "/sync/boards/resurrect",
        json={"base_version": 1, "scene_version": 2, "iv": IV, "ciphertext": b(b"y")},
    )
    assert r.status_code == 200
    g = await client.get("/sync/boards/resurrect")
    assert g.status_code == 200
