async def test_healthz_ok_without_auth(anon_client):
    r = await anon_client.get("/sync/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["db"] is True
    assert body["service"] == "excaliboard-sync"
    assert "version" in body
