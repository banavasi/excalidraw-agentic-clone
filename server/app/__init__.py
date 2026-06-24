"""Excaliboard sync server — versioned, opaque blob store.

See ``docs/design/phase2-cloud-sync.md`` and ``phase6-identity-auth.md``. The store
is opaque (it only reasons over the integer ``scene_version`` optimistic-concurrency
token); payloads are carried verbatim in the ``{iv, ciphertext}`` envelope. Phase 6
dropped E2E (the server is the user's own trusted box behind Cloudflare Access), so
those payloads are now plaintext-base64, not AES ciphertext.
"""

__version__ = "0.1.0"
