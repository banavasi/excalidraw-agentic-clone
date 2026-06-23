/**
 * Excaliboard Phase 2 — cloud sync primitives (config, crypto, REST backend, store).
 *
 * The server is an opaque-ciphertext blob store; ALL encryption happens here with
 * a client-only key, and conflict resolution (reconcileElements) runs client-side
 * (see {@link SyncEngine}). This module deliberately reuses the editor's existing
 * `encryptData`/`decryptData` (AES-128-GCM / JWK) verbatim — same primitives the
 * collab + firebase paths use — so the server never sees plaintext.
 *
 * Backend and store are interfaces so the engine is unit-testable with in-memory
 * fakes (no browser, IndexedDB, or live server required).
 */

import {
  decryptData,
  encryptData,
  generateEncryptionKey,
} from "@excalidraw/excalidraw/data/encryption";
import { createStore, del, get, set, keys } from "idb-keyval";

import type { ExcalidrawElement } from "@excalidraw/element/types";

// ---------------------------------------------------------------------------
// config (localStorage)
// ---------------------------------------------------------------------------

const SYNC_CONFIG_KEY = "excaliboard:sync-config";

export interface SyncConfig {
  /** Base URL of the sync service, e.g. https://sync.example.me (no trailing /). */
  serverUrl: string;
  /** Static bearer token (matches the server's SYNC_BEARER). */
  bearer: string;
  /** E2E AES-128-GCM key as a JWK string (from generateEncryptionKey()). */
  encryptionKey: string;
  /** Master on/off switch. */
  enabled: boolean;
}

export const getSyncConfig = (): SyncConfig | null => {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.serverUrl === "string" &&
      typeof parsed.bearer === "string" &&
      typeof parsed.encryptionKey === "string"
    ) {
      return {
        serverUrl: parsed.serverUrl.replace(/\/+$/, ""),
        bearer: parsed.bearer,
        encryptionKey: parsed.encryptionKey,
        enabled: !!parsed.enabled,
      };
    }
  } catch (error: any) {
    console.error(error);
  }
  return null;
};

export const setSyncConfig = (config: SyncConfig | null): void => {
  try {
    if (config === null) {
      localStorage.removeItem(SYNC_CONFIG_KEY);
    } else {
      localStorage.setItem(
        SYNC_CONFIG_KEY,
        JSON.stringify({
          ...config,
          serverUrl: config.serverUrl.replace(/\/+$/, ""),
        }),
      );
    }
  } catch (error: any) {
    console.error(error);
  }
};

export const isSyncConfigured = (
  config: SyncConfig | null,
): config is SyncConfig =>
  !!(
    config &&
    config.enabled &&
    config.serverUrl &&
    config.bearer &&
    config.encryptionKey
  );

/** Generate a fresh E2E key (JWK string) for first-time setup. */
export const generateSyncKey = (): Promise<string> => generateEncryptionKey();

// ---------------------------------------------------------------------------
// base64 <-> bytes (standard base64, interops with the server's b64)
// ---------------------------------------------------------------------------

export const toBase64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

export const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// ---------------------------------------------------------------------------
// crypto — element[] <-> { iv, ciphertext } (ported from firebase.ts verbatim)
// ---------------------------------------------------------------------------

export const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }> => {
  const encoded = new TextEncoder().encode(JSON.stringify(elements));
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return { iv, ciphertext: encryptedBuffer };
};

export const decryptElements = async (
  key: string,
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(iv, ciphertext, key);
  const decoded = new TextDecoder("utf-8").decode(new Uint8Array(decrypted));
  return JSON.parse(decoded);
};

/** Encrypt arbitrary bytes (e.g. a file's dataURL) for the blob store. */
export const encryptBytes = async (
  key: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<{ iv: string; ciphertext: string }> => {
  const { encryptedBuffer, iv } = await encryptData(key, data);
  return { iv: toBase64(iv), ciphertext: toBase64(encryptedBuffer) };
};

// ---------------------------------------------------------------------------
// REST backend
// ---------------------------------------------------------------------------

/** A scene as the server stores it (base64 ciphertext + IV). */
export interface ServerScene {
  sceneVersion: number;
  iv: string;
  ciphertext: string;
}

export interface IndexRow {
  boardId: string;
  nameIv: string | null;
  nameCt: string | null;
  sceneVersion: number;
  deleted: boolean;
  updatedAt: number;
}

export interface PushBody {
  base_version: number;
  scene_version: number;
  iv: string;
  ciphertext: string;
  name_iv?: string;
  name_ct?: string;
}

export type PushOutcome =
  | { ok: true; sceneVersion: number }
  | { ok: false; conflict: ServerScene };

export interface FileBlob {
  iv: string;
  ciphertext: string;
}

export interface SyncBackend {
  getIndex(sinceMs: number | null): Promise<IndexRow[]>;
  getBoard(boardId: string): Promise<ServerScene | null>;
  putBoard(boardId: string, body: PushBody): Promise<PushOutcome>;
  deleteBoard(boardId: string): Promise<void>;
  getFile(boardId: string, fileId: string): Promise<FileBlob | null>;
  putFile(boardId: string, fileId: string, body: FileBlob): Promise<void>;
}

/** HTTP error that reached the server (as opposed to a network/offline failure). */
export class SyncHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export class RestSyncBackend implements SyncBackend {
  private base: string;
  private bearer: string;

  constructor(config: Pick<SyncConfig, "serverUrl" | "bearer">) {
    this.base = config.serverUrl.replace(/\/+$/, "");
    this.bearer = config.bearer;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.bearer}`,
      "Content-Type": "application/json",
    };
  }

  async getIndex(sinceMs: number | null): Promise<IndexRow[]> {
    const q = sinceMs != null ? `?since=${sinceMs}` : "";
    const res = await fetch(`${this.base}/sync/index${q}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new SyncHttpError(res.status, `index ${res.status}`);
    }
    const rows = (await res.json()) as Array<Record<string, any>>;
    return rows.map((r) => ({
      boardId: r.board_id,
      nameIv: r.name_iv ?? null,
      nameCt: r.name_ct ?? null,
      sceneVersion: r.scene_version,
      deleted: !!r.deleted,
      updatedAt: r.updated_at,
    }));
  }

  async getBoard(boardId: string): Promise<ServerScene | null> {
    const res = await fetch(
      `${this.base}/sync/boards/${encodeURIComponent(boardId)}`,
      {
        headers: this.headers(),
      },
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new SyncHttpError(res.status, `getBoard ${res.status}`);
    }
    const j = await res.json();
    return {
      sceneVersion: j.scene_version,
      iv: j.iv,
      ciphertext: j.ciphertext,
    };
  }

  async putBoard(boardId: string, body: PushBody): Promise<PushOutcome> {
    const res = await fetch(
      `${this.base}/sync/boards/${encodeURIComponent(boardId)}`,
      {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
    );
    if (res.status === 200) {
      const j = await res.json();
      return { ok: true, sceneVersion: j.scene_version };
    }
    if (res.status === 409) {
      const j = await res.json();
      return {
        ok: false,
        conflict: {
          sceneVersion: j.scene_version,
          iv: j.iv,
          ciphertext: j.ciphertext,
        },
      };
    }
    throw new SyncHttpError(res.status, `putBoard ${res.status}`);
  }

  async deleteBoard(boardId: string): Promise<void> {
    const res = await fetch(
      `${this.base}/sync/boards/${encodeURIComponent(boardId)}`,
      {
        method: "DELETE",
        headers: this.headers(),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new SyncHttpError(res.status, `deleteBoard ${res.status}`);
    }
  }

  async getFile(boardId: string, fileId: string): Promise<FileBlob | null> {
    const res = await fetch(
      `${this.base}/sync/boards/${encodeURIComponent(
        boardId,
      )}/files/${encodeURIComponent(fileId)}`,
      { headers: this.headers() },
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new SyncHttpError(res.status, `getFile ${res.status}`);
    }
    const j = await res.json();
    return { iv: j.iv, ciphertext: j.ciphertext };
  }

  async putFile(
    boardId: string,
    fileId: string,
    body: FileBlob,
  ): Promise<void> {
    const res = await fetch(
      `${this.base}/sync/boards/${encodeURIComponent(
        boardId,
      )}/files/${encodeURIComponent(fileId)}`,
      { method: "PUT", headers: this.headers(), body: JSON.stringify(body) },
    );
    if (!res.ok) {
      throw new SyncHttpError(res.status, `putFile ${res.status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// sync store — per-board last-synced version + offline outbox
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  boardId: string;
  baseVersion: number;
  sceneVersion: number;
  iv: string;
  ciphertext: string;
  queuedAt: number;
}

export interface SyncStore {
  getLastSynced(boardId: string): Promise<number | null>;
  setLastSynced(boardId: string, version: number): Promise<void>;
  clearLastSynced(boardId: string): Promise<void>;
  /** Upsert by boardId (at most one queued entry per board — latest wins). */
  enqueue(entry: OutboxEntry): Promise<void>;
  listOutbox(): Promise<OutboxEntry[]>;
  dequeue(boardId: string): Promise<void>;
}

/** Production store backed by a dedicated IndexedDB store (idb-keyval). */
export class IdbSyncStore implements SyncStore {
  private versions = createStore("excaliboard-sync-db", "lastsynced");
  private outbox = createStore("excaliboard-sync-db", "outbox");

  async getLastSynced(boardId: string): Promise<number | null> {
    const v = await get<number>(boardId, this.versions);
    return v ?? null;
  }

  async setLastSynced(boardId: string, version: number): Promise<void> {
    await set(boardId, version, this.versions);
  }

  async clearLastSynced(boardId: string): Promise<void> {
    await del(boardId, this.versions);
  }

  async enqueue(entry: OutboxEntry): Promise<void> {
    await set(entry.boardId, entry, this.outbox);
  }

  async listOutbox(): Promise<OutboxEntry[]> {
    const ids = await keys(this.outbox);
    const entries = await Promise.all(
      ids.map((id) => get<OutboxEntry>(id as string, this.outbox)),
    );
    return entries.filter((e): e is OutboxEntry => !!e);
  }

  async dequeue(boardId: string): Promise<void> {
    await del(boardId, this.outbox);
  }
}

/** In-memory store for tests. */
export class MemorySyncStore implements SyncStore {
  private versions = new Map<string, number>();
  private outbox = new Map<string, OutboxEntry>();

  async getLastSynced(boardId: string): Promise<number | null> {
    return this.versions.has(boardId) ? this.versions.get(boardId)! : null;
  }

  async setLastSynced(boardId: string, version: number): Promise<void> {
    this.versions.set(boardId, version);
  }

  async clearLastSynced(boardId: string): Promise<void> {
    this.versions.delete(boardId);
  }

  async enqueue(entry: OutboxEntry): Promise<void> {
    this.outbox.set(entry.boardId, entry);
  }

  async listOutbox(): Promise<OutboxEntry[]> {
    return [...this.outbox.values()];
  }

  async dequeue(boardId: string): Promise<void> {
    this.outbox.delete(boardId);
  }
}
