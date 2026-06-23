"""The server is opaque: it stores and returns exactly the bytes it was given,
and never exposes plaintext. Plus payload-validation guards (base64, size, body)."""

import os

from tests.util import IV, b, make_client, ub


async def test_arbitrary_binary_roundtrips_unchanged(client):
    blob = os.urandom(512)
    iv = os.urandom(12)
    await client.put(
        "/sync/boards/op",
        json={"base_version": 0, "scene_version": 1, "iv": b(iv), "ciphertext": b(blob)},
    )
    g = (await client.get("/sync/boards/op")).json()
    # Exactly what was sent comes back — proves the server never parses content.
    assert ub(g["ciphertext"]) == blob
    assert ub(g["iv"]) == iv


async def test_invalid_base64_rejected(client):
    r = await client.put(
        "/sync/boards/bad",
        json={"base_version": 0, "scene_version": 1, "iv": "!!notbase64!!", "ciphertext": "$$$"},
    )
    assert r.status_code == 422


async def test_oversize_ciphertext_rejected():
    # Tiny cap so we don't have to generate 25 MiB to exercise the guard.
    async with make_client(max_ciphertext_bytes=16) as ac:
        r = await ac.put(
            "/sync/boards/big",
            json={
                "base_version": 0,
                "scene_version": 1,
                "iv": IV,
                "ciphertext": b(b"x" * 64),  # 64 bytes > 16 cap
            },
        )
        assert r.status_code == 413


async def test_oversize_body_rejected_by_content_length():
    # A whole-body cap below the JSON size -> rejected before the handler runs.
    async with make_client(max_body_bytes=300) as ac:
        r = await ac.put(
            "/sync/boards/toobig",
            json={"base_version": 0, "scene_version": 1, "iv": IV, "ciphertext": b(b"x" * 2000)},
        )
        assert r.status_code == 413
        # Handler never ran => the board was not created.
        g = await ac.get("/sync/boards/toobig")
        assert g.status_code == 404


async def test_oversize_body_rejected_when_streamed_without_content_length():
    async def chunks():
        yield b'{"base_version":0,"scene_version":1,"iv":"' + IV.encode()
        yield b'","ciphertext":"'
        yield b"A" * 4000  # pushes the running total past the cap mid-stream
        yield b'"}'

    async with make_client(max_body_bytes=300) as ac:
        r = await ac.put(
            "/sync/boards/streambig",
            content=chunks(),
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 413
