import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";

import type { AppState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { STORAGE_KEYS } from "../app_constants";
import { LocalData } from "../data/LocalData";
import {
  DEFAULT_WORKBOARD_NAME,
  createWorkboard,
  deleteWorkboard,
  duplicateWorkboard,
  ensureWorkboardIndexSync,
  getActiveWorkboardId,
  getBoardVersionKey,
  listAllReferencedFileIds,
  loadWorkboardData,
  loadWorkboardIndex,
  loadWorkboardThumbnail,
  migrateLegacyDataIfNeeded,
  renameWorkboard,
  saveWorkboardData,
  saveWorkboardThumbnail,
  setActiveWorkboardId,
} from "../workboards/data";

const imageElement = (fileId: string): ExcalidrawElement =>
  ({
    id: `el-${fileId}`,
    type: "image",
    fileId,
  } as unknown as ExcalidrawElement);

describe("workboards data layer", () => {
  beforeEach(() => {
    // index/active/version stamps + legacy keys all live in localStorage;
    // clearing it resets the visible workboard state between tests (orphan IDB
    // entries for ids not in the index are never read).
    localStorage.clear();
  });

  describe("ensureWorkboardIndexSync", () => {
    it("creates a default board + active id when none exist", () => {
      expect(loadWorkboardIndex()).toEqual([]);
      const id = ensureWorkboardIndexSync();
      const index = loadWorkboardIndex();
      expect(index).toHaveLength(1);
      expect(index[0].id).toBe(id);
      expect(index[0].name).toBe(DEFAULT_WORKBOARD_NAME);
      expect(getActiveWorkboardId()).toBe(id);
    });

    it("keeps an existing valid active id (idempotent)", () => {
      const id = ensureWorkboardIndexSync();
      expect(ensureWorkboardIndexSync()).toBe(id);
      expect(loadWorkboardIndex()).toHaveLength(1);
    });

    it("repairs an invalid/missing active id", () => {
      const id = ensureWorkboardIndexSync();
      setActiveWorkboardId("does-not-exist");
      expect(ensureWorkboardIndexSync()).toBe(id);
      expect(getActiveWorkboardId()).toBe(id);
    });
  });

  describe("CRUD", () => {
    it("creates boards with unique ids, appended to the index", () => {
      const a = createWorkboard("Alpha");
      const b = createWorkboard("Beta");
      expect(a.id).not.toBe(b.id);
      expect(loadWorkboardIndex().map((x) => x.id)).toEqual([a.id, b.id]);
    });

    it("auto-names untitled boards uniquely", () => {
      const a = createWorkboard();
      const b = createWorkboard();
      expect(a.name).toBe("Untitled board");
      expect(b.name).toBe("Untitled board 2");
    });

    it("round-trips board data through IndexedDB", async () => {
      const board = createWorkboard("Board A");
      await saveWorkboardData(board.id, {
        elements: [imageElement("f1")],
        appState: { name: "Board A" },
      });
      const data = await loadWorkboardData(board.id);
      expect(data?.elements).toHaveLength(1);
      expect(data?.appState?.name).toBe("Board A");
    });

    it("renames a board (and ignores empty names)", () => {
      const board = createWorkboard("Old");
      renameWorkboard(board.id, "New");
      expect(loadWorkboardIndex().find((b) => b.id === board.id)?.name).toBe(
        "New",
      );
      renameWorkboard(board.id, "   ");
      expect(loadWorkboardIndex().find((b) => b.id === board.id)?.name).toBe(
        "New",
      );
    });

    it("deletes a board and its data", async () => {
      const board = createWorkboard("Doomed");
      await saveWorkboardData(board.id, {
        elements: [imageElement("f1")],
        appState: null,
      });
      const remaining = await deleteWorkboard(board.id);
      expect(remaining.find((b) => b.id === board.id)).toBeUndefined();
      expect(await loadWorkboardData(board.id)).toBeNull();
    });

    it("duplicates a board with its data + thumbnail under a new id", async () => {
      const board = createWorkboard("Original");
      await saveWorkboardData(board.id, {
        elements: [imageElement("f1")],
        appState: { name: "Original" },
      });
      await saveWorkboardThumbnail(board.id, "data:image/png;base64,AAAA");

      const copy = await duplicateWorkboard(board.id);
      expect(copy).not.toBeNull();
      expect(copy!.id).not.toBe(board.id);
      expect(copy!.name).toBe("Original (copy)");

      const copyData = await loadWorkboardData(copy!.id);
      expect(copyData?.elements).toHaveLength(1);
      expect(await loadWorkboardThumbnail(copy!.id)).toBe(
        "data:image/png;base64,AAAA",
      );
    });
  });

  describe("legacy single-canvas migration", () => {
    it("migrates legacy localStorage into the active board, keeping the legacy keys as a fallback", async () => {
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
        JSON.stringify([imageElement("legacy-file")]),
      );
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
        JSON.stringify({ name: "Legacy" }),
      );

      const activeId = ensureWorkboardIndexSync();
      await migrateLegacyDataIfNeeded(activeId);

      const data = await loadWorkboardData(activeId);
      expect(data?.elements).toHaveLength(1);
      expect(data?.appState?.name).toBe("Legacy");
      // legacy keys are intentionally retained as a loss-safe fallback
      expect(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
      ).not.toBeNull();
    });

    it("seeds an empty board when legacy JSON is corrupt (never strands the editor)", async () => {
      localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, "{not json");
      const activeId = ensureWorkboardIndexSync();
      await migrateLegacyDataIfNeeded(activeId);
      const data = await loadWorkboardData(activeId);
      expect(data).not.toBeNull();
      expect(data?.elements).toEqual([]);
    });

    it("is idempotent and never clobbers existing board data", async () => {
      const activeId = ensureWorkboardIndexSync();
      await saveWorkboardData(activeId, {
        elements: [imageElement("keep")],
        appState: null,
      });
      // legacy keys present but must be IGNORED since the board already has data
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
        JSON.stringify([imageElement("legacy")]),
      );

      await migrateLegacyDataIfNeeded(activeId);

      const data = await loadWorkboardData(activeId);
      expect(data?.elements).toHaveLength(1);
      expect((data!.elements[0] as { fileId: string }).fileId).toBe("keep");
    });

    it("seeds an empty board when there is no legacy data", async () => {
      const activeId = ensureWorkboardIndexSync();
      await migrateLegacyDataIfNeeded(activeId);
      const data = await loadWorkboardData(activeId);
      expect(data).not.toBeNull();
      expect(data?.elements).toEqual([]);
    });
  });

  describe("board-aware file references (cleanup safety)", () => {
    it("returns the union of fileIds referenced across all boards", async () => {
      const a = createWorkboard("A");
      const b = createWorkboard("B");
      await saveWorkboardData(a.id, {
        elements: [imageElement("shared"), imageElement("onlyA")],
        appState: null,
      });
      await saveWorkboardData(b.id, {
        elements: [imageElement("shared"), imageElement("onlyB")],
        appState: null,
      });
      const { fileIds, complete } = await listAllReferencedFileIds();
      expect([...fileIds].sort()).toEqual(["onlyA", "onlyB", "shared"]);
      expect(complete).toBe(true);
    });

    it("ignores boards without image elements", async () => {
      const a = createWorkboard("A");
      await saveWorkboardData(a.id, {
        elements: [{ id: "r", type: "rectangle" } as ExcalidrawElement],
        appState: null,
      });
      const { fileIds, complete } = await listAllReferencedFileIds();
      expect(fileIds).toEqual([]);
      expect(complete).toBe(true);
    });

    it("fails closed (complete=false) when the index itself is corrupt", async () => {
      localStorage.setItem(STORAGE_KEYS.WORKBOARDS_INDEX, "{ not valid json");
      const { fileIds, complete } = await listAllReferencedFileIds();
      expect(complete).toBe(false);
      expect(fileIds).toEqual([]);
    });
  });

  describe("unload/crash recovery snapshot", () => {
    it("round-trips a recovery snapshot and clears it", () => {
      LocalData.writeRecovery(
        "board-1",
        [imageElement("f1")],
        getDefaultAppState() as AppState,
      );
      const recovery = LocalData.readRecovery();
      expect(recovery?.boardId).toBe("board-1");
      expect(recovery?.elements).toHaveLength(1);
      expect(typeof recovery?.ts).toBe("number");

      LocalData.clearRecovery();
      expect(LocalData.readRecovery()).toBeNull();
    });
  });

  describe("import .excalidraw as a new board", () => {
    it("parses an .excalidraw blob and seeds a new board with its elements", async () => {
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "test",
        elements: [
          {
            id: "rect-1",
            type: "rectangle",
            x: 10,
            y: 20,
            width: 100,
            height: 50,
          },
        ],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      };
      const blob = new Blob([JSON.stringify(scene)], {
        type: "application/json",
      });
      const data = await loadFromBlob(blob as Blob, null, null);
      expect(data.elements?.length).toBe(1);

      // the import handler then creates a board from the parsed scene
      const board = createWorkboard("imported");
      await saveWorkboardData(board.id, {
        elements: data.elements ?? [],
        appState: data.appState ?? null,
      });
      const round = await loadWorkboardData(board.id);
      expect(round?.elements).toHaveLength(1);
      expect((round!.elements[0] as { type: string }).type).toBe("rectangle");
    });
  });

  describe("getBoardVersionKey", () => {
    it("namespaces the tab-sync data-state stamp per board", () => {
      expect(getBoardVersionKey("abc")).toBe(
        `${STORAGE_KEYS.VERSION_DATA_STATE}:abc`,
      );
    });
  });
});
