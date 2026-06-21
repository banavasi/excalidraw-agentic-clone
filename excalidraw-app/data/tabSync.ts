import { STORAGE_KEYS } from "../app_constants";

// in-memory state (this tab's current state) versions. Currently just
// timestamps of the last time the state was saved to browser storage.
//
// Keys are dynamic strings: `version-files` is global (the binary files store
// is shared across boards), while data-state stamps are per-board
// (`version-dataState:<boardId>`, see workboards/data.ts:getBoardVersionKey).
const LOCAL_STATE_VERSIONS: Record<string, number> = {};

export const isBrowserStorageStateNewer = (type: string) => {
  const storageTimestamp = JSON.parse(localStorage.getItem(type) || "-1");
  const knownTimestamp = LOCAL_STATE_VERSIONS[type] ?? -1;
  return storageTimestamp > knownTimestamp;
};

export const updateBrowserStateVersion = (type: string) => {
  const timestamp = Date.now();
  try {
    localStorage.setItem(type, JSON.stringify(timestamp));
    LOCAL_STATE_VERSIONS[type] = timestamp;
  } catch (error) {
    console.error("error while updating browser state verison", error);
  }
};

/**
 * Records the persisted stamp for `type` as already-seen by this tab, WITHOUT
 * bumping it. Used right after loading a board into the editor so a subsequent
 * focus/visibility `syncData` doesn't treat the just-loaded board as "newer in
 * storage" and re-import it over unsaved post-load edits.
 */
export const markBrowserStateVersionSeen = (type: string) => {
  LOCAL_STATE_VERSIONS[type] = JSON.parse(localStorage.getItem(type) || "-1");
};

const isVersionKey = (key: string) =>
  key === STORAGE_KEYS.VERSION_FILES ||
  key === STORAGE_KEYS.VERSION_DATA_STATE ||
  key.startsWith(`${STORAGE_KEYS.VERSION_DATA_STATE}:`);

export const resetBrowserStateVersions = () => {
  try {
    // reset every persisted version stamp (per-board data-state + files),
    // not just the ones this tab happens to have touched in-memory — during a
    // collab session no local saves run, so the in-memory map can be empty
    // even though stale localStorage stamps exist.
    const keys = new Set<string>(Object.keys(LOCAL_STATE_VERSIONS));
    keys.add(STORAGE_KEYS.VERSION_FILES);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isVersionKey(key)) {
        keys.add(key);
      }
    }
    for (const key of keys) {
      const timestamp = -1;
      localStorage.setItem(key, JSON.stringify(timestamp));
      LOCAL_STATE_VERSIONS[key] = timestamp;
    }
  } catch (error) {
    console.error("error while resetting browser state verison", error);
  }
};
