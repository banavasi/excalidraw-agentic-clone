"""CORS_ORIGINS comes from an env var as a raw comma-separated string (or "*").
pydantic-settings must NOT JSON-decode it (that crashed the container on deploy)."""

from app.config import Settings


def test_cors_origins_star_from_env(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "*")
    assert Settings().cors_origins == ["*"]


def test_cors_origins_csv_from_env(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://a.com, https://b.com")
    assert Settings().cors_origins == ["https://a.com", "https://b.com"]


def test_cors_origins_default_and_programmatic():
    assert Settings(database_url=None).cors_origins == ["*"]
    assert Settings(cors_origins=["https://x"]).cors_origins == ["https://x"]
