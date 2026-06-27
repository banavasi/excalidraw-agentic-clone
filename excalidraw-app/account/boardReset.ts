/**
 * Account-switch board reset.
 *
 * The local board space (workboards index + content + sync metadata) is ONE
 * space per browser, mapped to ONE server account. We stamp which account it
 * belongs to; when a DIFFERENT account signs in we wipe it COMPLETELY *before*
 * the editor boots, so we never inherit — or push — another account's boards.
 *
 * Logout itself does NOT wipe: same-account logout→login keeps everything, which
 * is why this lives here (gated on identity) rather than in the sign-out handler.
 */

import { STORAGE_KEYS } from "../app_constants";

const OWNER_KEY = "excaliboard:owner";

// idb-keyval names its DB `${name}-db` (see workboards/data.ts + excaliboardSync.ts).
const BOARD_DBS = [
  "excaliboard-sync-db",
  `${STORAGE_KEYS.IDB_WORKBOARDS}-db`,
  `${STORAGE_KEYS.IDB_WORKBOARD_THUMBNAILS}-db`,
];

// Exact localStorage keys holding board data (NOT theme/debug prefs, NOT the
// sync-enabled flag — those survive an account switch).
const BOARD_KEYS = new Set<string>([
  STORAGE_KEYS.WORKBOARDS_INDEX,
  STORAGE_KEYS.WORKBOARDS_ACTIVE,
  STORAGE_KEYS.WORKBOARDS_RECOVERY,
  STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, // legacy scene — else it re-seeds board 1
  STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
  STORAGE_KEYS.LOCAL_STORAGE_COLLAB,
]);

const deleteDb = (name: string): Promise<void> =>
  new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

/** Complete, awaited wipe of all local board state. */
export const resetLocalBoardState = async (): Promise<void> => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (
        BOARD_KEYS.has(key) ||
        key.startsWith(STORAGE_KEYS.VERSION_DATA_STATE)
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* best-effort */
  }
  // No editor is mounted yet (AuthGate gates it), so no open IDB connection can
  // block these deletes.
  await Promise.all(BOARD_DBS.map(deleteDb));
};

export const getBoardOwner = (): string | null => {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
};

export const setBoardOwner = (email: string): void => {
  try {
    localStorage.setItem(OWNER_KEY, email);
  } catch {
    /* ignore */
  }
};
