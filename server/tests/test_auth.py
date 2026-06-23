from tests.util import BEARER


async def test_index_requires_auth(anon_client):
    r = await anon_client.get("/sync/index")
    assert r.status_code == 401
    assert r.headers.get("www-authenticate") == "Bearer"


async def test_wrong_bearer_rejected(anon_client):
    r = await anon_client.get("/sync/index", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


async def test_malformed_authorization_rejected(anon_client):
    r = await anon_client.get("/sync/index", headers={"Authorization": BEARER})  # no "Bearer "
    assert r.status_code == 401


async def test_valid_bearer_accepted(client):
    r = await client.get("/sync/index")
    assert r.status_code == 200
    assert r.json() == []
