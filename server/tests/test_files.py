from tests.util import IV, b, ub


def _scene(payload: bytes) -> dict:
    return {"base_version": 0, "scene_version": 1, "iv": IV, "ciphertext": b(payload)}


async def test_put_get_file(client):
    await client.put("/sync/boards/fb", json=_scene(b"s"))
    p = await client.put(
        "/sync/boards/fb/files/file1", json={"iv": IV, "ciphertext": b(b"img-bytes")}
    )
    assert p.status_code == 200
    assert p.json() == {"ok": True}

    g = await client.get("/sync/boards/fb/files/file1")
    assert g.status_code == 200
    assert ub(g.json()["ciphertext"]) == b"img-bytes"


async def test_put_file_missing_board_404(client):
    p = await client.put(
        "/sync/boards/nope/files/file1", json={"iv": IV, "ciphertext": b(b"x")}
    )
    assert p.status_code == 404


async def test_get_missing_file_404(client):
    await client.put("/sync/boards/fb2", json=_scene(b"s"))
    g = await client.get("/sync/boards/fb2/files/ghost")
    assert g.status_code == 404


async def test_put_file_idempotent(client):
    await client.put("/sync/boards/fb3", json=_scene(b"s"))
    payload = {"iv": IV, "ciphertext": b(b"same")}
    a = await client.put("/sync/boards/fb3/files/f", json=payload)
    bb = await client.put("/sync/boards/fb3/files/f", json=payload)
    assert a.status_code == 200
    assert bb.status_code == 200
    g = await client.get("/sync/boards/fb3/files/f")
    assert ub(g.json()["ciphertext"]) == b"same"
