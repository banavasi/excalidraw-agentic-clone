/**
 * Workboards (multi-canvas) data layer.
 *
 * A *workspace* holds many *workboards*. To avoid the editor's single-`Scene`
 * assumption (see docs/design/excaliboard-spec.md), a workboard is a swappable
 * persisted document, not a live Scene. Storage is split by size:
 *
 *  - localStorage (small, sync, drives tab-sync `storage` events):
 *      - `excaliboard:index`  -> Workboard[] metadata
 *      - `excaliboard:active` -> active board id
 *      - `version-dataState:<id>` -> per-board tab-sync stamp (see tabSync.ts)
 *  - IndexedDB (large blobs):
 *      - workboards store      -> id -> { elements, appState }
 *      - thumbnails store      -> id -> dataURL
 *
 * Binary image files stay in the shared `files-store` (see LocalData.ts); the
 * per-board cleanup uses {@link listAllReferencedFileIds} so an image used by
 * one board is never deleted while editing another.
 */

import { isInitializedImageElement } from "@excalidraw/element";
import { createStore, del, get, set } from "idb-keyval";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";

export interface Workboard {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkboardData {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState> | null;
}

const boardsStore = createStore(
  `${STORAGE_KEYS.IDB_WORKBOARDS}-db`,
  `${STORAGE_KEYS.IDB_WORKBOARDS}-store`,
);

const thumbnailsStore = createStore(
  `${STORAGE_KEYS.IDB_WORKBOARD_THUMBNAILS}-db`,
  `${STORAGE_KEYS.IDB_WORKBOARD_THUMBNAILS}-store`,
);

export const DEFAULT_WORKBOARD_NAME = "My first board";

/** localStorage key for a board's tab-sync data-state stamp. */
export const getBoardVersionKey = (boardId: string) =>
  `${STORAGE_KEYS.VERSION_DATA_STATE}:${boardId}`;

const generateWorkboardId = (): string => {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch (error: any) {
    // fall through to the manual id below
  }
  return `wb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const nextUntitledName = (boards: Workboard[]): string => {
  const base = "Untitled board";
  const existing = new Set(boards.map((b) => b.name));
  if (!existing.has(base)) {
    return base;
  }
  let n = 2;
  while (existing.has(`${base} ${n}`)) {
    n++;
  }
  return `${base} ${n}`;
};

// ---------------------------------------------------------------------------
// index (localStorage)
// ---------------------------------------------------------------------------

/**
 * Reads the index, distinguishing a genuinely-empty index (`ok: true`) from an
 * unreadable/corrupt one (`ok: false`). Callers that delete data based on the
 * index (file cleanup) must FAIL CLOSED when `ok` is false.
 */
const readWorkboardIndex = (): { boards: Workboard[]; ok: boolean } => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEYS.WORKBOARDS_INDEX);
  } catch (error: any) {
    console.error(error);
    return { boards: [], ok: false };
  }
  if (raw == null) {
    return { boards: [], ok: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { boards: [], ok: false };
    }
    return {
      boards: parsed.filter(
        (b): b is Workboard =>
          !!b && typeof b.id === "string" && typeof b.name === "string",
      ),
      ok: true,
    };
  } catch (error: any) {
    console.error(error);
    return { boards: [], ok: false };
  }
};

export const loadWorkboardIndex = (): Workboard[] =>
  readWorkboardIndex().boards;

const persistWorkboardIndex = (boards: Workboard[]) => {
  try {
    localStorage.setItem(STORAGE_KEYS.WORKBOARDS_INDEX, JSON.stringify(boards));
  } catch (error: any) {
    console.error(error);
  }
};

export const getActiveWorkboardId = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEYS.WORKBOARDS_ACTIVE);
  } catch (error: any) {
    console.error(error);
    return null;
  }
};

export const setActiveWorkboardId = (id: string) => {
  try {
    localStorage.setItem(STORAGE_KEYS.WORKBOARDS_ACTIVE, id);
  } catch (error: any) {
    console.error(error);
  }
};

const touchWorkboard = (id: string) => {
  const boards = loadWorkboardIndex();
  const idx = boards.findIndex((b) => b.id === id);
  if (idx !== -1) {
    boards[idx] = { ...boards[idx], updatedAt: Date.now() };
    persistWorkboardIndex(boards);
  }
};

// ---------------------------------------------------------------------------
// board data (IndexedDB)
// ---------------------------------------------------------------------------

export const loadWorkboardData = async (
  id: string,
): Promise<WorkboardData | null> => {
  try {
    const data = await get<WorkboardData>(id, boardsStore);
    return data ?? null;
  } catch (error: any) {
    console.error(error);
    return null;
  }
};

export const saveWorkboardData = async (
  id: string,
  data: WorkboardData,
): Promise<void> => {
  await set(
    id,
    { elements: data.elements, appState: data.appState ?? null },
    boardsStore,
  );
  touchWorkboard(id);
};

// ---------------------------------------------------------------------------
// thumbnails (IndexedDB)
// ---------------------------------------------------------------------------

export const saveWorkboardThumbnail = async (id: string, dataURL: string) => {
  try {
    await set(id, dataURL, thumbnailsStore);
  } catch (error: any) {
    console.error(error);
  }
};

export const loadWorkboardThumbnail = async (
  id: string,
): Promise<string | null> => {
  try {
    return (await get<string>(id, thumbnailsStore)) ?? null;
  } catch (error: any) {
    console.error(error);
    return null;
  }
};

// ---------------------------------------------------------------------------
// CRUD (index + data)
// ---------------------------------------------------------------------------

export const createWorkboard = (name?: string): Workboard => {
  const boards = loadWorkboardIndex();
  const now = Date.now();
  const board: Workboard = {
    id: generateWorkboardId(),
    name: name?.trim() || nextUntitledName(boards),
    createdAt: now,
    updatedAt: now,
  };
  persistWorkboardIndex([...boards, board]);
  return board;
};

export const renameWorkboard = (id: string, name: string): Workboard[] => {
  const trimmed = name.trim();
  const boards = loadWorkboardIndex().map((b) =>
    b.id === id && trimmed ? { ...b, name: trimmed, updatedAt: Date.now() } : b,
  );
  persistWorkboardIndex(boards);
  return boards;
};

export const deleteWorkboard = async (id: string): Promise<Workboard[]> => {
  const boards = loadWorkboardIndex().filter((b) => b.id !== id);
  persistWorkboardIndex(boards);
  try {
    await del(id, boardsStore);
    await del(id, thumbnailsStore);
  } catch (error: any) {
    console.error(error);
  }
  return boards;
};

/**
 * Duplicates a board (metadata + data + thumbnail). Element ids are kept as-is;
 * boards are isolated scenes loaded one at a time, so cross-board id overlap is
 * harmless, and `restoreElements({ repairBindings: true })` runs on every load.
 */
export const duplicateWorkboard = async (
  id: string,
): Promise<Workboard | null> => {
  const source = loadWorkboardIndex().find((b) => b.id === id);
  if (!source) {
    return null;
  }
  const copy = createWorkboard(`${source.name} (copy)`);
  const data = await loadWorkboardData(id);
  if (data) {
    await saveWorkboardData(copy.id, data);
  }
  const thumbnail = await loadWorkboardThumbnail(id);
  if (thumbnail) {
    await saveWorkboardThumbnail(copy.id, thumbnail);
  }
  return copy;
};

// ---------------------------------------------------------------------------
// files referenced across ALL boards (for board-aware obsolete-file cleanup)
// ---------------------------------------------------------------------------

/**
 * Collects the fileIds referenced by ALL boards (the live set for obsolete-file
 * cleanup). Returns `complete: false` if any board's data couldn't be read, so
 * callers can FAIL CLOSED — deleting files based on an incomplete union could
 * permanently remove an image still referenced by an unreadable board.
 */
export const listAllReferencedFileIds = async (): Promise<{
  fileIds: FileId[];
  complete: boolean;
}> => {
  const { boards, ok } = readWorkboardIndex();
  // a corrupt index means we don't know which files other boards reference —
  // fail closed so cleanup doesn't delete a still-referenced image
  if (!ok) {
    return { fileIds: [], complete: false };
  }
  const fileIds = new Set<FileId>();
  let complete = true;
  await Promise.all(
    boards.map(async (board) => {
      try {
        const data = await get<WorkboardData>(board.id, boardsStore);
        data?.elements?.forEach((element) => {
          if (isInitializedImageElement(element)) {
            fileIds.add(element.fileId);
          }
        });
      } catch (error: any) {
        console.error(error);
        complete = false;
      }
    }),
  );
  return { fileIds: [...fileIds], complete };
};

// ---------------------------------------------------------------------------
// initialization & legacy migration
// ---------------------------------------------------------------------------

/**
 * Synchronously ensures an index + a valid active board id exist (no IndexedDB
 * writes). Safe to call eagerly during render so the active board id is
 * available before the first `onChange`. Returns the active board id.
 */
export const ensureWorkboardIndexSync = (): string => {
  let boards = loadWorkboardIndex();
  if (boards.length === 0) {
    const now = Date.now();
    const board: Workboard = {
      id: generateWorkboardId(),
      name: DEFAULT_WORKBOARD_NAME,
      createdAt: now,
      updatedAt: now,
    };
    boards = [board];
    persistWorkboardIndex(boards);
    setActiveWorkboardId(board.id);
    return board.id;
  }
  let activeId = getActiveWorkboardId();
  if (!activeId || !boards.some((b) => b.id === activeId)) {
    activeId = boards[0].id;
    setActiveWorkboardId(activeId);
  }
  return activeId;
};

const safeParse = <T>(raw: string | null): T | null => {
  if (raw == null) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error: any) {
    console.error(error);
    return null;
  }
};

/**
 * If the active board has no IndexedDB data yet, seed it from legacy
 * single-canvas localStorage data (or empty). Idempotent.
 *
 * The legacy keys are intentionally NOT deleted — they're kept as a loss-safe
 * fallback for (a) the Excalidraw+ export iframe, which runs before the editor
 * mounts and migrates, and (b) the rare two-tabs-on-first-launch race where one
 * tab could otherwise orphan the migrated board out of the index. They are
 * ignored on subsequent loads once the board has data, and are small (a single
 * canvas), so leaving them is cheap.
 */
export const migrateLegacyDataIfNeeded = async (
  activeId: string,
): Promise<void> => {
  const existing = await loadWorkboardData(activeId);
  if (existing) {
    return;
  }
  // each field parsed independently so one corrupt key can't abort the seed and
  // leave the board with no record (which would loop a failing parse forever)
  const elements =
    safeParse<ExcalidrawElement[]>(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ) ?? [];
  const appState = safeParse<Partial<AppState>>(
    localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE),
  );
  await saveWorkboardData(activeId, { elements, appState });
};
