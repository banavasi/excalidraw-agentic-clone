/**
 * This file deals with saving data state (appState, elements, images, ...)
 * locally to the browser.
 *
 * Notes:
 *
 * - DataState refers to full state of the app: appState, elements, images,
 *   though some state is saved separately (collab username, library) for one
 *   reason or another. We also save different data to different storage
 *   (localStorage, indexedDB).
 */

import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import {
  CANVAS_SEARCH_TAB,
  DEFAULT_SIDEBAR,
  debounce,
} from "@excalidraw/common";
import {
  createStore,
  entries,
  del,
  getMany,
  set,
  setMany,
  get,
} from "idb-keyval";

import { getNonDeletedElements } from "@excalidraw/element";

import type { LibraryPersistedData } from "@excalidraw/excalidraw/data/library";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { MaybePromise } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import { SAVE_TO_LOCAL_STORAGE_TIMEOUT, STORAGE_KEYS } from "../app_constants";
import { getBoardVersionKey, saveWorkboardData } from "../workboards/data";

import { FileManager } from "./FileManager";
import { FileStatusStore } from "./fileStatusStore";
import { Locker } from "./Locker";
import { updateBrowserStateVersion } from "./tabSync";

const filesStore = createStore("files-db", "files-store");

export const localStorageQuotaExceededAtom = atom(false);

class LocalFileManager extends FileManager {
  clearObsoleteFiles = async (opts: { currentFileIds: FileId[] }) => {
    await entries(filesStore).then((entries) => {
      for (const [id, imageData] of entries as [FileId, BinaryFileData][]) {
        // if image is unused (not on canvas) & is older than 1 day, delete it
        // from storage. We check `lastRetrieved` we care about the last time
        // the image was used (loaded on canvas), not when it was initially
        // created.
        if (
          (!imageData.lastRetrieved ||
            Date.now() - imageData.lastRetrieved > 24 * 3600 * 1000) &&
          !opts.currentFileIds.includes(id as FileId)
        ) {
          del(id, filesStore);
        }
      }
    });
  };
}

/**
 * Persists a single board's scene data (non-deleted elements + cleaned
 * appState) to the workboards IndexedDB store and bumps the board's per-board
 * tab-sync stamp. Replaces the legacy single-canvas localStorage write.
 */
const saveBoardDataToStorage = async (
  boardId: string,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
) => {
  const localStorageQuotaExceeded = appJotaiStore.get(
    localStorageQuotaExceededAtom,
  );
  try {
    const _appState = clearAppStateForLocalStorage(appState);

    if (
      _appState.openSidebar?.name === DEFAULT_SIDEBAR.name &&
      _appState.openSidebar.tab === CANVAS_SEARCH_TAB
    ) {
      _appState.openSidebar = null;
    }

    await saveWorkboardData(boardId, {
      elements: getNonDeletedElements(elements),
      appState: _appState,
    });
    updateBrowserStateVersion(getBoardVersionKey(boardId));
    if (localStorageQuotaExceeded) {
      appJotaiStore.set(localStorageQuotaExceededAtom, false);
    }
  } catch (error: any) {
    // Unable to access storage
    console.error(error);
    if (isQuotaExceededError(error) && !localStorageQuotaExceeded) {
      appJotaiStore.set(localStorageQuotaExceededAtom, true);
    }
  }
};

const isQuotaExceededError = (error: any) => {
  return error instanceof DOMException && error.name === "QuotaExceededError";
};

type SavingLockTypes = "collaboration";

type DebouncedSaver = ((
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
  onFilesSaved: () => void,
) => void) & { flush: () => void; cancel: () => void };

export class LocalData {
  /**
   * One debounce timer PER board. A single shared debounce would mean that
   * scheduling a save for board B clears board A's pending save (the debounce
   * has a single handle) — which silently drops edits made to A during a board
   * switch. Per-board savers each carry their own board's args, so a pending
   * write always lands on the correct board.
   */
  private static _savers = new Map<string, DebouncedSaver>();

  private static getSaver(boardId: string): DebouncedSaver {
    let saver = this._savers.get(boardId);
    if (!saver) {
      saver = debounce(
        async (
          elements: readonly ExcalidrawElement[],
          appState: AppState,
          files: BinaryFiles,
          onFilesSaved: () => void,
        ) => {
          await saveBoardDataToStorage(boardId, elements, appState);
          await this.fileStorage.saveFiles({ elements, files });
          onFilesSaved();
        },
        SAVE_TO_LOCAL_STORAGE_TIMEOUT,
      ) as DebouncedSaver;
      this._savers.set(boardId, saver);
    }
    return saver;
  }

  /** Saves DataState for the given board, including files. Bails if saving is
   * paused or there is no active board yet. */
  static save = (
    boardId: string | null,
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    onFilesSaved: () => void,
  ) => {
    // we need to make the `isSavePaused` check synchronously (undebounced)
    if (boardId && !this.isSavePaused()) {
      this.getSaver(boardId)(elements, appState, files, onFilesSaved);
    }
  };

  static flushSave = () => {
    for (const saver of this._savers.values()) {
      saver.flush();
    }
  };

  /** Cancels pending debounced saves. Pass a `boardId` to cancel only that
   * board's pending write (e.g. before deleting it, or before persisting the
   * outgoing board on a switch); omit to cancel all. */
  static cancelSave = (boardId?: string) => {
    if (boardId) {
      this._savers.get(boardId)?.cancel();
    } else {
      for (const saver of this._savers.values()) {
        saver.cancel();
      }
    }
  };

  /** Immediately (awaited, undebounced) persists a board's scene + files.
   * Used by the board-switch flow to guarantee the outgoing board is saved
   * before the incoming board is loaded. */
  static saveImmediately = async (
    boardId: string,
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    await saveBoardDataToStorage(boardId, elements, appState);
    await this.fileStorage.saveFiles({ elements, files });
  };

  /** Synchronously mirrors the active board's scene to localStorage. IndexedDB
   * writes don't reliably complete during unload, so this is the durable
   * crash/unload snapshot; {@link readRecovery} prefers it on load when newer
   * than the last persisted IDB save (compared via the board's version stamp).
   * Binary files are NOT mirrored (they already live durably in the files
   * store), only element + appState. */
  static writeRecovery = (
    boardId: string,
    elements: readonly ExcalidrawElement[],
    appState: AppState,
  ) => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.WORKBOARDS_RECOVERY,
        JSON.stringify({
          boardId,
          elements: getNonDeletedElements(elements),
          appState: clearAppStateForLocalStorage(appState),
          ts: Date.now(),
        }),
      );
    } catch (error: any) {
      console.error(error);
    }
  };

  static readRecovery = (): {
    boardId: string;
    elements: ExcalidrawElement[];
    appState: AppState;
    ts: number;
  } | null => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.WORKBOARDS_RECOVERY);
      return raw ? JSON.parse(raw) : null;
    } catch (error: any) {
      console.error(error);
      return null;
    }
  };

  static clearRecovery = () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.WORKBOARDS_RECOVERY);
    } catch (error: any) {
      console.error(error);
    }
  };

  private static locker = new Locker<SavingLockTypes>();

  static pauseSave = (lockType: SavingLockTypes) => {
    this.locker.lock(lockType);
  };

  static resumeSave = (lockType: SavingLockTypes) => {
    this.locker.unlock(lockType);
  };

  static isSavePaused = () => {
    return document.hidden || this.locker.isLocked();
  };

  // ---------------------------------------------------------------------------

  static fileStorage = new LocalFileManager({
    onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
    getFiles(ids) {
      return getMany(ids, filesStore).then(
        async (filesData: (BinaryFileData | undefined)[]) => {
          const loadedFiles: BinaryFileData[] = [];
          const erroredFiles = new Map<FileId, true>();

          const filesToSave: [FileId, BinaryFileData][] = [];

          filesData.forEach((data, index) => {
            const id = ids[index];
            if (data) {
              const _data: BinaryFileData = {
                ...data,
                lastRetrieved: Date.now(),
              };
              filesToSave.push([id, _data]);
              loadedFiles.push(_data);
            } else {
              erroredFiles.set(id, true);
            }
          });

          try {
            // save loaded files back to storage with updated `lastRetrieved`
            setMany(filesToSave, filesStore);
          } catch (error) {
            console.warn(error);
          }

          return { loadedFiles, erroredFiles };
        },
      );
    },
    async saveFiles({ addedFiles }) {
      const savedFiles = new Map<FileId, BinaryFileData>();
      const erroredFiles = new Map<FileId, BinaryFileData>();

      // before we use `storage` event synchronization, let's update the flag
      // optimistically. Hopefully nothing fails, and an IDB read executed
      // before an IDB write finishes will read the latest value.
      updateBrowserStateVersion(STORAGE_KEYS.VERSION_FILES);

      await Promise.all(
        [...addedFiles].map(async ([id, fileData]) => {
          try {
            await set(id, fileData, filesStore);
            savedFiles.set(id, fileData);
          } catch (error: any) {
            console.error(error);
            erroredFiles.set(id, fileData);
          }
        }),
      );

      return { savedFiles, erroredFiles };
    },
  });
}
export class LibraryIndexedDBAdapter {
  /** IndexedDB database and store name */
  private static idb_name = STORAGE_KEYS.IDB_LIBRARY;
  /** library data store key */
  private static key = "libraryData";

  private static store = createStore(
    `${LibraryIndexedDBAdapter.idb_name}-db`,
    `${LibraryIndexedDBAdapter.idb_name}-store`,
  );

  static async load() {
    const IDBData = await get<LibraryPersistedData>(
      LibraryIndexedDBAdapter.key,
      LibraryIndexedDBAdapter.store,
    );

    return IDBData || null;
  }

  static save(data: LibraryPersistedData): MaybePromise<void> {
    return set(
      LibraryIndexedDBAdapter.key,
      data,
      LibraryIndexedDBAdapter.store,
    );
  }
}

/** LS Adapter used only for migrating LS library data
 * to indexedDB */
export class LibraryLocalStorageMigrationAdapter {
  static load() {
    const LSData = localStorage.getItem(
      STORAGE_KEYS.__LEGACY_LOCAL_STORAGE_LIBRARY,
    );
    if (LSData != null) {
      const libraryItems: ImportedDataState["libraryItems"] =
        JSON.parse(LSData);
      if (libraryItems) {
        return { libraryItems };
      }
    }
    return null;
  }
  static clear() {
    localStorage.removeItem(STORAGE_KEYS.__LEGACY_LOCAL_STORAGE_LIBRARY);
  }
}
