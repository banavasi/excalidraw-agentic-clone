"""Aggregate anti-DoS caps: boards-per-user and files-per-board."""

from tests.util import IV, b, make_client


def _scene(payload: bytes) -> dict:
    return {"base_version": 0, "scene_version": 1, "iv": IV, "ciphertext": b(payload)}


async def test_max_boards_per_user_enforced():
    async with make_client(max_boards_per_user=2) as ac:
        for i in range(2):
            r = await ac.put(f"/sync/boards/b{i}", json=_scene(b"x"))
            assert r.status_code == 200
        # Third NEW board exceeds the cap.
        r = await ac.put("/sync/boards/b2", json=_scene(b"x"))
        assert r.status_code == 413
        # Updating an EXISTING board is unaffected by the cap.
        r = await ac.put(
            "/sync/boards/b0",
            json={"base_version": 1, "scene_version": 2, "iv": IV, "ciphertext": b(b"y")},
        )
        assert r.status_code == 200


async def test_max_files_per_board_enforced():
    async with make_client(max_files_per_board=1) as ac:
        await ac.put("/sync/boards/fb", json=_scene(b"s"))
        r = await ac.put("/sync/boards/fb/files/f0", json={"iv": IV, "ciphertext": b(b"a")})
        assert r.status_code == 200
        # Second NEW file exceeds the cap.
        r = await ac.put("/sync/boards/fb/files/f1", json={"iv": IV, "ciphertext": b(b"b")})
        assert r.status_code == 413
        # Re-putting an EXISTING file id is idempotent (content-addressed) and allowed.
        r = await ac.put("/sync/boards/fb/files/f0", json={"iv": IV, "ciphertext": b(b"a")})
        assert r.status_code == 200
