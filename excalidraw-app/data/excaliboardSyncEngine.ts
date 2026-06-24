/**
 * Excaliboard Phase 2 — the sync engine.
 *
 * Sits between the Phase-1 per-board store and the server. Conflict resolution is
 * IDENTICAL to the live collab path (Collab._reconcileElements):
 *   decrypt server scene -> restoreElements -> reconcileElements -> bumpElementVersions
 *   -> applyRemote (updateScene NEVER) -> re-encrypt -> retry PUT with the merged base.
 * The server can't decrypt, so the merge MUST happen here.
 *
 * All editor/storage/network access is injected (see {@link SyncEngineDeps}) so the
 * engine is unit-tested with in-memory fakes — no browser, IndexedDB, or live server.
 */

import { reconcileElements } from "@excalidraw/excalidraw";
import {
  bumpElementVersions,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import {
  getSceneVersion,
  isInitializedImageElement,
} from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { SYNC_FULL_SCENE_INTERVAL_MS } from "../app_constants";

import {
  decryptElements,
  decryptString,
  encryptElements,
  encryptString,
  fromBase64,
  SyncHttpError,
  toBase64,
} from "./excaliboardSync";

import { getSyncableElements } from "./index";

import type {
  IndexRow,
  ServerScene,
  SyncBackend,
  SyncStore,
} from "./excaliboardSync";

const MAX_PUSH_RETRIES = 5;

/** Bridges the live editor (the active board's scene). */
export interface EditorBridge {
  /** Elements of the active board, including deleted (tombstones). */
  getElements(): readonly OrderedExcalidrawElement[];
  getAppState(): AppState;
  /** Apply a reconciled remote scene WITHOUT creating an undo entry (captureUpdate NEVER). */
  applyRemote(elements: readonly OrderedExcalidrawElement[]): void;
  /** The active board's loaded binary file, if the editor has it. */
  getFile(fileId: FileId): BinaryFileData | undefined;
  /** Add downloaded binary files to the editor (active board). */
  addFiles(files: BinaryFileData[]): void;
}

/** Image fileIds referenced by the scene (deduped). */
const referencedFileIds = (
  elements: readonly OrderedExcalidrawElement[],
): FileId[] => {
  const ids = new Set<FileId>();
  for (const element of elements) {
    if (isInitializedImageElement(element)) {
      ids.add(element.fileId);
    }
  }
  return [...ids];
};

const mimeFromDataURL = (dataURL: string): string => {
  const match = dataURL.match(/^data:([^;,]+)/);
  return match ? match[1] : "image/png";
};

/** Bridges Phase-1 per-board persistence for NON-active (background) boards. */
export interface BoardStore {
  load(boardId: string): Promise<readonly OrderedExcalidrawElement[] | null>;
  save(
    boardId: string,
    elements: readonly OrderedExcalidrawElement[],
  ): Promise<void>;
  /** A board was tombstoned on the server — remove it locally. */
  remove(boardId: string): Promise<void>;
  /** Local name of a board (to push with its scene), or null. */
  getName(boardId: string): string | null;
  /** Register/rename a board in the local switcher; true if the index changed. */
  upsertBoard(boardId: string, name: string): boolean;
}

export interface SyncEngineDeps {
  backend: SyncBackend;
  store: SyncStore;
  bridge: EditorBridge;
  boards: BoardStore;
  getActiveBoardId: () => string | null;
  getKey: () => string;
  now: () => number;
  /** Called after a pull changes the local board list (refresh the switcher UI). */
  onBoardsChanged: () => void;
}

interface MergeResult {
  syncable: readonly OrderedExcalidrawElement[];
  version: number;
}

export class SyncEngine {
  private deps: SyncEngineDeps;
  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pulling = false;
  private indexCursor: number | null = null;
  private pullInterval: ReturnType<typeof setInterval> | null = null;
  // Boards deleted locally this session — a pull must NOT re-register them while the
  // DELETE is still in-flight (it races the pull) or if a stray push briefly revived
  // them. Cleared once the server's index confirms the tombstone (row.deleted).
  private locallyDeleted = new Set<string>();
  private onlineHandler = () => {
    void this.flushOutbox();
  };

  constructor(deps: SyncEngineDeps) {
    this.deps = deps;
  }

  // -- lifecycle ------------------------------------------------------------

  start(): void {
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onlineHandler);
    }
    this.pullInterval = setInterval(() => {
      void this.pull();
    }, SYNC_FULL_SCENE_INTERVAL_MS);
    void this.flushOutbox();
    void this.pull();
  }

  stop(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onlineHandler);
    }
    if (this.pullInterval) {
      clearInterval(this.pullInterval);
      this.pullInterval = null;
    }
    for (const timer of this.pushTimers.values()) {
      clearTimeout(timer);
    }
    this.pushTimers.clear();
  }

  // -- push (debounced on local change) -------------------------------------

  /** Debounced (20s, trailing) push of a board after a local edit. */
  notifyLocalChange(boardId: string): void {
    const existing = this.pushTimers.get(boardId);
    if (existing) {
      clearTimeout(existing);
    }
    this.pushTimers.set(
      boardId,
      setTimeout(() => {
        this.pushTimers.delete(boardId);
        void this.pushBoard(boardId);
      }, SYNC_FULL_SCENE_INTERVAL_MS),
    );
  }

  async pushBoard(boardId: string): Promise<void> {
    const elements = await this.localElements(boardId);
    if (!elements) {
      return;
    }
    const syncable = getSyncableElements(elements);
    const sceneVersion = getSceneVersion(syncable);
    const lastSynced = await this.deps.store.getLastSynced(boardId);
    if (lastSynced === sceneVersion) {
      return; // skip-redundant: nothing changed since the last successful push
    }
    const { iv, ciphertext } = await encryptElements(
      this.deps.getKey(),
      syncable,
    );
    const ivB64 = toBase64(iv);
    const ctB64 = toBase64(ciphertext);
    const base = lastSynced ?? 0;

    try {
      const outcome = await this.deps.backend.putBoard(boardId, {
        base_version: base,
        scene_version: sceneVersion,
        iv: ivB64,
        ciphertext: ctB64,
        ...(await this.nameFields(boardId)),
      });
      if (outcome.ok) {
        await this.deps.store.setLastSynced(boardId, outcome.sceneVersion);
        await this.syncFilesUp(boardId);
      } else {
        await this.reconcileAndRetry(boardId, syncable, outcome.conflict);
      }
    } catch (e) {
      await this.handlePushError(e, {
        boardId,
        baseVersion: base,
        sceneVersion,
        iv: ivB64,
        ciphertext: ctB64,
      });
    }
  }

  /**
   * Push a board's name even when its scene is unchanged (e.g. after a rename).
   * Re-PUTs the current scene + the new encrypted name with base=lastSynced.
   */
  async pushBoardName(boardId: string): Promise<void> {
    if (this.deps.boards.getName(boardId) == null) {
      return;
    }
    const lastSynced = await this.deps.store.getLastSynced(boardId);
    if (lastSynced == null) {
      void this.pushBoard(boardId); // not on the server yet — a scene push carries it
      return;
    }
    const elements = await this.localElements(boardId);
    if (!elements) {
      return;
    }
    const syncable = getSyncableElements(elements);
    const { iv, ciphertext } = await encryptElements(
      this.deps.getKey(),
      syncable,
    );
    try {
      const outcome = await this.deps.backend.putBoard(boardId, {
        base_version: lastSynced,
        scene_version: getSceneVersion(syncable),
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
        ...(await this.nameFields(boardId)),
      });
      if (outcome.ok) {
        await this.deps.store.setLastSynced(boardId, outcome.sceneVersion);
      }
      // on conflict/offline the name re-pushes on the next pull or scene edit
    } catch {
      // offline — retry later
    }
  }

  // -- conflict resolution (409) --------------------------------------------

  private async reconcileAndRetry(
    boardId: string,
    localSyncable: readonly OrderedExcalidrawElement[],
    conflict: ServerScene,
  ): Promise<void> {
    let local = localSyncable;
    let server = conflict;

    for (let attempt = 0; attempt < MAX_PUSH_RETRIES; attempt++) {
      const merged = await this.mergeRemote(boardId, server, local);
      const { iv, ciphertext } = await encryptElements(
        this.deps.getKey(),
        merged.syncable,
      );
      const ivB64 = toBase64(iv);
      const ctB64 = toBase64(ciphertext);
      try {
        const outcome = await this.deps.backend.putBoard(boardId, {
          base_version: server.sceneVersion,
          scene_version: merged.version,
          iv: ivB64,
          ciphertext: ctB64,
          ...(await this.nameFields(boardId)),
        });
        if (outcome.ok) {
          await this.deps.store.setLastSynced(boardId, outcome.sceneVersion);
          await this.syncFilesUp(boardId);
          return;
        }
        local = merged.syncable;
        server = outcome.conflict;
      } catch (e) {
        await this.handlePushError(e, {
          boardId,
          baseVersion: server.sceneVersion,
          sceneVersion: merged.version,
          iv: ivB64,
          ciphertext: ctB64,
        });
        return;
      }
    }
    // Convergence failed (rare hot-loop); leave the latest state queued.
    await this.deps.store.enqueue({
      boardId,
      baseVersion: server.sceneVersion,
      sceneVersion: getSceneVersion(local),
      iv: "",
      ciphertext: "",
      queuedAt: this.deps.now(),
    });
  }

  /**
   * Decrypt the server scene, reconcile it against the current LOCAL scene, apply
   * the merge (live for the active board, IDB for a background board), and return
   * the merged syncable elements + version. Mirrors Collab._reconcileElements.
   */
  private async mergeRemote(
    boardId: string,
    server: ServerScene,
    fallbackLocal: readonly OrderedExcalidrawElement[],
  ): Promise<MergeResult> {
    const key = this.deps.getKey();
    const remoteElements = await decryptElements(
      key,
      fromBase64(server.iv),
      fromBase64(server.ciphertext),
    );

    const isActive = boardId === this.deps.getActiveBoardId();
    const localElements =
      (isActive
        ? this.deps.bridge.getElements()
        : await this.deps.boards.load(boardId)) ?? fallbackLocal;
    const appState = isActive
      ? this.deps.bridge.getAppState()
      : ({} as AppState);

    const restored = restoreElements(
      remoteElements,
      localElements,
    ) as unknown as RemoteExcalidrawElement[];
    let reconciled = reconcileElements(
      localElements,
      restored,
      appState,
    ) as unknown as OrderedExcalidrawElement[];
    reconciled = bumpElementVersions(
      reconciled,
      localElements,
    ) as unknown as OrderedExcalidrawElement[];

    if (isActive) {
      this.deps.bridge.applyRemote(reconciled);
    } else {
      await this.deps.boards.save(boardId, reconciled);
    }

    const syncable = getSyncableElements(reconciled);
    return { syncable, version: getSceneVersion(syncable) };
  }

  // -- image/file sync (active board only) ----------------------------------

  /** Push referenced image files the server doesn't have yet. Best-effort. */
  private async syncFilesUp(boardId: string): Promise<void> {
    if (boardId !== this.deps.getActiveBoardId()) {
      return; // only the active board's files are loaded in the editor
    }
    try {
      const key = this.deps.getKey();
      for (const fileId of referencedFileIds(this.deps.bridge.getElements())) {
        const file = this.deps.bridge.getFile(fileId);
        if (!file?.dataURL) {
          continue;
        }
        if (await this.deps.backend.getFile(boardId, fileId)) {
          continue; // content-addressed file already on the server
        }
        await this.deps.backend.putFile(
          boardId,
          fileId,
          await encryptString(key, file.dataURL),
        );
      }
    } catch {
      // best-effort; files retry on the next push/pull
    }
  }

  /** Download referenced image files the editor is missing. Best-effort. */
  private async syncFilesDown(boardId: string): Promise<void> {
    if (boardId !== this.deps.getActiveBoardId()) {
      return;
    }
    try {
      const key = this.deps.getKey();
      const loaded: BinaryFileData[] = [];
      for (const fileId of referencedFileIds(this.deps.bridge.getElements())) {
        if (this.deps.bridge.getFile(fileId)) {
          continue; // editor already has it
        }
        const blob = await this.deps.backend.getFile(boardId, fileId);
        if (!blob) {
          continue;
        }
        const dataURL = await decryptString(
          key,
          fromBase64(blob.iv),
          fromBase64(blob.ciphertext),
        );
        loaded.push({
          id: fileId,
          dataURL: dataURL as DataURL,
          mimeType: mimeFromDataURL(dataURL) as BinaryFileData["mimeType"],
          created: this.deps.now(),
        });
      }
      if (loaded.length) {
        this.deps.bridge.addFiles(loaded);
      }
    } catch {
      // best-effort
    }
  }

  // -- pull (focus / visibility / interval) ---------------------------------

  async pull(): Promise<void> {
    if (this.pulling) {
      return;
    }
    this.pulling = true;
    try {
      const rows = await this.deps.backend.getIndex(this.indexCursor);
      let touched = false;
      for (const row of rows) {
        this.indexCursor = Math.max(this.indexCursor ?? 0, row.updatedAt);
        if (row.deleted) {
          this.locallyDeleted.delete(row.boardId); // server confirms the tombstone
          if (await this.handleRemoteDelete(row.boardId)) {
            touched = true;
          }
          continue;
        }
        if (this.locallyDeleted.has(row.boardId)) {
          // We deleted this locally but the server still shows it live (the DELETE
          // is in-flight, or a stray push beat us). Re-assert the delete and do NOT
          // re-register it into the switcher.
          void this.deps.backend.deleteBoard(row.boardId);
          continue;
        }
        // Surface the board in the local switcher (decrypt + register its name),
        // so a freshly-authenticated device shows ALL your boards.
        if (await this.registerBoard(row)) {
          touched = true;
        }
        const lastSynced = await this.deps.store.getLastSynced(row.boardId);
        if (lastSynced === row.sceneVersion) {
          continue; // already have this server version
        }
        const scene = await this.deps.backend.getBoard(row.boardId);
        if (scene) {
          await this.applyServerScene(row.boardId, scene);
        }
      }
      if (touched) {
        this.deps.onBoardsChanged();
      }
    } catch (e) {
      // network/offline or transient server error — try again next tick.
      if (e instanceof SyncHttpError && e.status === 401) {
        console.error(
          "excaliboard sync: unauthorized (check the bearer token)",
        );
      }
    } finally {
      this.pulling = false;
    }
  }

  private async applyServerScene(
    boardId: string,
    scene: ServerScene,
  ): Promise<void> {
    const local = await this.localElements(boardId);
    const merged = await this.mergeRemote(boardId, scene, local ?? []);
    // We've incorporated the server's scene — record it as our base BEFORE any
    // push, so the upload below uses base=scene.sceneVersion (not a stale 0).
    await this.deps.store.setLastSynced(boardId, scene.sceneVersion);
    await this.syncFilesDown(boardId);
    if (merged.version !== scene.sceneVersion) {
      // `restore` re-versions elements during repair, and/or local had unpushed
      // edits folded into the merge — upload the merged scene so the server agrees.
      // (Mirrors collab, which broadcasts the post-reconcile version.)
      await this.pushBoard(boardId);
    }
  }

  private async handleRemoteDelete(boardId: string): Promise<boolean> {
    if (boardId === this.deps.getActiveBoardId()) {
      return false; // never yank the board the user is currently editing
    }
    const lastSynced = await this.deps.store.getLastSynced(boardId);
    if (lastSynced == null) {
      return false; // never had it locally
    }
    await this.deps.boards.remove(boardId);
    await this.deps.store.clearLastSynced(boardId);
    return true;
  }

  /** Decrypt + register a server board into the local switcher. */
  private async registerBoard(row: IndexRow): Promise<boolean> {
    let name = "Untitled board";
    // Name presence is the ciphertext; the iv is vestigial (empty) since E2E was
    // dropped (see excaliboardSync.ts), so don't gate on row.nameIv being truthy.
    if (row.nameCt) {
      try {
        name = await decryptString(
          this.deps.getKey(),
          fromBase64(row.nameIv ?? ""), // iv ignored (E2E dropped); may be null/empty
          fromBase64(row.nameCt),
        );
      } catch {
        // keep the default name if the encrypted name can't be decrypted
      }
    }
    return this.deps.boards.upsertBoard(row.boardId, name);
  }

  /** Encrypted name fields to ride along with a scene push (or undefined). */
  private async nameFields(
    boardId: string,
  ): Promise<{ name_iv: string; name_ct: string } | undefined> {
    const name = this.deps.boards.getName(boardId);
    if (name == null) {
      return undefined;
    }
    const enc = await encryptString(this.deps.getKey(), name);
    return { name_iv: enc.iv, name_ct: enc.ciphertext };
  }

  /** Download missing image files for the active board (e.g. after a switch). */
  async downloadActiveBoardFiles(): Promise<void> {
    const active = this.deps.getActiveBoardId();
    if (active) {
      await this.syncFilesDown(active);
    }
  }

  // -- delete propagation ---------------------------------------------------

  async softDelete(boardId: string): Promise<void> {
    // Remember it so a pull racing the in-flight DELETE doesn't re-register it.
    this.locallyDeleted.add(boardId);
    // Cancel any pending debounced push for this board — otherwise a stray push
    // could land just after the delete (which the server would then refuse to
    // revive, but there's no point firing it).
    const timer = this.pushTimers.get(boardId);
    if (timer) {
      clearTimeout(timer);
      this.pushTimers.delete(boardId);
    }
    await this.deps.store.clearLastSynced(boardId);
    await this.deps.store.dequeue(boardId);
    try {
      await this.deps.backend.deleteBoard(boardId);
    } catch (e) {
      // best-effort; the tombstone will be re-asserted on the next delete/edit.
      if (!(e instanceof SyncHttpError)) {
        console.warn("excaliboard sync: delete deferred (offline)");
      }
    }
  }

  // -- offline outbox -------------------------------------------------------

  async flushOutbox(): Promise<void> {
    const entries = await this.deps.store.listOutbox();
    for (const entry of entries) {
      try {
        const outcome = await this.deps.backend.putBoard(entry.boardId, {
          base_version: entry.baseVersion,
          scene_version: entry.sceneVersion,
          iv: entry.iv,
          ciphertext: entry.ciphertext,
        });
        if (outcome.ok) {
          await this.deps.store.setLastSynced(
            entry.boardId,
            outcome.sceneVersion,
          );
          await this.deps.store.dequeue(entry.boardId);
        } else {
          // server advanced while we were offline — reconcile against current local.
          const local = await this.localElements(entry.boardId);
          await this.reconcileAndRetry(
            entry.boardId,
            local ?? [],
            outcome.conflict,
          );
          await this.deps.store.dequeue(entry.boardId);
        }
      } catch (e) {
        if (e instanceof SyncHttpError) {
          // permanent-ish (4xx) — drop so we don't wedge the queue.
          await this.deps.store.dequeue(entry.boardId);
        } else {
          return; // still offline — stop; retry on the next 'online'/interval.
        }
      }
    }
  }

  // -- helpers --------------------------------------------------------------

  private async localElements(
    boardId: string,
  ): Promise<readonly OrderedExcalidrawElement[] | null> {
    if (boardId === this.deps.getActiveBoardId()) {
      return this.deps.bridge.getElements();
    }
    return this.deps.boards.load(boardId);
  }

  private async handlePushError(
    e: unknown,
    queued: {
      boardId: string;
      baseVersion: number;
      sceneVersion: number;
      iv: string;
      ciphertext: string;
    },
  ): Promise<void> {
    if (e instanceof SyncHttpError) {
      if (e.status >= 500) {
        // transient server error — queue for retry.
        await this.deps.store.enqueue({ ...queued, queuedAt: this.deps.now() });
      } else {
        // 401/413/etc — log; don't wedge the queue with an unfixable push.
        console.error(`excaliboard sync: push rejected (${e.status})`);
      }
      return;
    }
    // network/offline — persist for the outbox flusher.
    await this.deps.store.enqueue({ ...queued, queuedAt: this.deps.now() });
  }
}
