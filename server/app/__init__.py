"""Excaliboard sync server — versioned, opaque-ciphertext blob store.

See ``docs/design/phase2-cloud-sync.md``. The server never sees plaintext:
all payloads are client-encrypted (AES-GCM / JWK), and the server only reasons
over the integer ``scene_version`` (optimistic-concurrency token) and IVs.
"""

__version__ = "0.1.0"
