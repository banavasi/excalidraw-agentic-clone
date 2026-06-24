/**
 * Production wiring for the Excaliboard sync engine.
 *
 * Adapts the live editor (ExcalidrawImperativeAPI) and the Phase-1 workboards
 * store into the engine's injected interfaces, and exposes a small module-level
 * API the app calls from onChange / focus / delete / board-switch. A no-op when
 * sync isn't configured, so the rest of the app stays oblivious.
 */

import { CaptureUpdateAction } from "@excalidraw/excalidraw";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  deleteWorkboard,
  getWorkboardName,
  loadWorkboardData,
  saveWorkboardData,
  upsertWorkboardIndexEntry,
} from "../workboards/data";

import {
  IdbSyncStore,
  RestSyncBackend,
  getSyncConfig,
  isSyncConfigured,
} from "./excaliboardSync";
import { SyncEngine } from "./excaliboardSyncEngine";

import type { BoardStore, EditorBridge } from "./excaliboardSyncEngine";

let engine: SyncEngine | null = null;

const createEditorBridge = (api: ExcalidrawImperativeAPI): EditorBridge => ({
  getElements: () => api.getSceneElementsIncludingDeleted(),
  getAppState: () => api.getAppState(),
  applyRemote: (elements) =>
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER }),
  getFile: (fileId) => api.getFiles()[fileId],
  addFiles: (files) => api.addFiles(files),
});

const createBoardStore = (): BoardStore => ({
  load: async (boardId) => {
    const data = await loadWorkboardData(boardId);
    return (data?.elements as readonly OrderedExcalidrawElement[]) ?? null;
  },
  save: async (boardId, elements) => {
    // preserve the board's appState; only the scene is reconciled
    const existing = await loadWorkboardData(boardId);
    await saveWorkboardData(boardId, {
      elements,
      appState: existing?.appState ?? null,
    });
  },
  remove: async (boardId) => {
    await deleteWorkboard(boardId);
  },
  getName: (boardId) => getWorkboardName(boardId),
  upsertBoard: (boardId, name) => upsertWorkboardIndexEntry(boardId, name),
});

/** (Re)build and start the engine from the saved config. Idempotent. */
export const initExcaliboardSync = (opts: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  getActiveBoardId: () => string | null;
  onBoardsChanged: () => void;
}): void => {
  stopExcaliboardSync();
  const config = getSyncConfig();
  if (!isSyncConfigured(config)) {
    return;
  }
  engine = new SyncEngine({
    // serverUrl "" = same-origin: the browser rides the Cloudflare Access cookie.
    backend: new RestSyncBackend({ serverUrl: "" }),
    store: new IdbSyncStore(),
    bridge: createEditorBridge(opts.excalidrawAPI),
    boards: createBoardStore(),
    getActiveBoardId: opts.getActiveBoardId,
    getKey: () => "", // E2E dropped (D4); the engine threads this through as a no-op.
    now: () => Date.now(),
    onBoardsChanged: opts.onBoardsChanged,
  });
  engine.start();
};

export const stopExcaliboardSync = (): void => {
  engine?.stop();
  engine = null;
};

export const isSyncRunning = (): boolean => engine !== null;

/** A local edit happened on a board — schedule a debounced push. */
export const notifyBoardChanged = (boardId: string | null): void => {
  if (engine && boardId) {
    engine.notifyLocalChange(boardId);
  }
};

/** Pull server changes now (focus / visibility / board-switch). */
export const pullExcaliboardSync = (): void => {
  void engine?.pull();
};

/** Propagate a local board deletion to the server (soft-delete tombstone). Returns a
 * promise so callers can AWAIT it: a fire-and-forget DELETE gets cancelled by a page
 * refresh, leaving the board live on the server (so it reappears on the next pull). */
export const softDeleteBoardSync = (boardId: string): Promise<void> =>
  engine?.softDelete(boardId) ?? Promise.resolve();

/** Download missing image files for the active board (after a board switch). */
export const downloadActiveBoardFiles = (): void => {
  void engine?.downloadActiveBoardFiles();
};

/** Propagate a board rename to the server (pushes the encrypted name). */
export const syncBoardName = (boardId: string): void => {
  void engine?.pushBoardName(boardId);
};
