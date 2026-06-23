# Excaliboard Phase 5 — MCP server + agentic board creation (design spec)

> **Status:** DRAFT — awaiting sign-off. **Date:** 2026-06-23. Depends on Phase 2 (cloud sync, live) + Phase 4 (`/excaliboard` skill).

## 1. Goal & shape

Let an **agent (Claude / MCP) and the `/excaliboard` skill create, read, and update boards in your
synced account** — so a board authored by automation shows up on every device, exactly like one you
drew. Two surfaces, one core:

```
/excaliboard skill ─┐
                     ├─► excaliboard tool (holds E2E key + bearer) ──HTTPS──► cosmos sync server
MCP client (Claude) ─┘   encrypt locally · reconcile · push           (opaque ciphertext, Phase 2)
                          exposed as REST + MCP via the gateway        boards then sync to all devices
```

## 2. The one architectural decision (signed off)

The sync server is **E2E-opaque** — it can't create or read a board in plaintext. So the MCP tool and
the skill act as **trusted headless clients**: they hold the **E2E key** (`op://Mithra/excaliboard-e2e-key`)
and the **bearer** (`op://Mithra/excaliboard-sync-auth`), encrypt locally, and push. The key now lives
wherever this automation runs (cosmos, via the gateway's `op` service account) — the natural single-user
model. **Confirmed.**

## 3. Crypto compatibility (the critical detail)

A board created by the tool MUST decrypt in the browser. The client uses
`encryptData` = **AES-128-GCM**, **12-byte IV**, key imported from the JWK `k` (base64url 16 bytes),
output = `ciphertext || 16-byte tag` (WebCrypto). Python's `cryptography` `AESGCM` produces the identical
layout, so the tool reuses it verbatim:
- key = `base64url-decode(JWK k)` (16 bytes) → `AESGCM(key)`
- `iv = os.urandom(12)`; `blob = AESGCM.encrypt(iv, json.dumps(elements).encode(), None)` → store `iv` + `blob` (base64), exactly the Phase-2 wire shape.
- `scene_version = sum(el["version"] for el in elements)` (matches `getSceneVersion`).
- board name encrypted the same way (Part-1 `name_iv`/`name_ct`).

This is verified-by-construction against `packages/excalidraw/data/encryption.ts`; a round-trip test
(Python encrypt → JS decrypt and vice-versa) is the gate.

## 4. The `excaliboard` tool (agentic-os pattern)

Per `build:agentic-os-tools`: a tool with an `agentic.toml`, invoked through the FastAPI gateway, each op
exposed as **REST + an MCP tool `excaliboard__<op>`** at `mcp.shashankshandilya.me`.

| Op | Does |
|---|---|
| `excaliboard__list` | `GET /sync/index` → decrypt names → `[{board_id, name, scene_version}]` |
| `excaliboard__get` | `GET /sync/boards/{id}` (+ files) → decrypt → elements |
| `excaliboard__create` | encrypt elements + name → `PUT` a new board (uuid, base_version 0); push files |
| `excaliboard__update` | pull → `reconcileElements`-equivalent → re-encrypt → `PUT` (CAS, retry on 409) |
| `excaliboard__delete` | `DELETE /sync/boards/{id}` |

- **Language: Python** (pragmatic — the `/excaliboard` skill + the crypto + the scene authoring are all
  Python; ⚠️ diverges from the Rust-CLI default in `build:agentic-os-tools` — calling it out for sign-off).
- Runs where the gateway runs (cosmos), reading secrets via the `op` service account.
- Reconcile on update: v1 can be **last-writer (CAS overwrite)** since the agent rarely races a human;
  full `reconcileElements` parity is a follow-up. (Decision to confirm.)

## 5. The `/excaliboard` skill → synced boards

The skill already authors a real `.excalidraw` scene (verified against the editor's restore pipeline).
Add a **"create into my synced account"** path: after authoring, call `excaliboard__create` (or the REST
endpoint) with the elements + a name. The board appears on every device via Part-1 index sync. Keeps the
existing `~/brain` filing as an option (`--no-sync`).

## 6. KEY DECISIONS (recommendations)

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Tool language | **Python** | reuse the skill's authoring + crypto; the Rust default doesn't fit a JS-crypto/scene domain |
| D2 | Where it runs | **cosmos (gateway)** | `op` service account already there; same box as the sync server (low latency) |
| D3 | Update conflict policy | **CAS overwrite v1** | agent-vs-human races are rare; full reconcile is a follow-up |
| D4 | Skill ↔ server | **via the tool** (not direct) | one place holds the key + encodes the wire format |

## 7. Definition of done

- `excaliboard__create` from Claude (or `/excaliboard --sync`) produces a board that **opens and renders
  in the browser** (round-trip crypto verified), named, on every device.
- `list`/`get`/`update`/`delete` work over MCP; secrets only from 1P Mithra; tool registered in the gateway.
- No change to the opaque sync server (it already stores everything the tool needs).

## 8. Build order (on sign-off)

1. The Python crypto+sync core (encrypt/decrypt to the Phase-2 wire shape) + a **JS↔Python round-trip test**.
2. The `excaliboard` tool (`agentic.toml`, ops) + gateway registration (REST + MCP).
3. The `/excaliboard` skill `--sync` path.
4. Deploy via the existing cosmos CI/CD; verify `excaliboard__create` → board visible in the app.
