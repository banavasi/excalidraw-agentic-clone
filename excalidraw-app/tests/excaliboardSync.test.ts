import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { getSceneVersion } from "@excalidraw/element";

import type {
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  DataURL,
} from "@excalidraw/excalidraw/types";

import {
  MemorySyncStore,
  decryptElements,
  decryptString,
  encryptElements,
  encryptString,
  fromBase64,
  generateSyncKey,
  toBase64,
  type IndexRow,
  type PushBody,
  type PushOutcome,
  type ServerScene,
  type SyncBackend,
  type FileBlob,
} from "../data/excaliboardSync";
import {
  SyncEngine,
  type BoardStore,
  type EditorBridge,
  type SyncEngineDeps,
} from "../data/excaliboardSyncEngine";

// --- fakes -----------------------------------------------------------------

class MockBackend implements SyncBackend {
  scenes = new Map<string, ServerScene>();
  files = new Map<string, FileBlob>();
  indexRows: IndexRow[] = [];
  putCalls: { boardId: string; body: PushBody }[] = [];
  online = true;

  async getIndex(): Promise<IndexRow[]> {
    return this.indexRows;
  }

  async getBoard(boardId: string): Promise<ServerScene | null> {
    return this.scenes.get(boardId) ?? null;
  }

  async putBoard(boardId: string, body: PushBody): Promise<PushOutcome> {
    this.putCalls.push({ boardId, body });
    if (!this.online) {
      throw new TypeError("Failed to fetch"); // mimic a network failure
    }
    const cur = this.scenes.get(boardId);
    if (!cur || cur.sceneVersion === body.base_version) {
      this.scenes.set(boardId, {
        sceneVersion: body.scene_version,
        iv: body.iv,
        ciphertext: body.ciphertext,
      });
      return { ok: true, sceneVersion: body.scene_version };
    }
    return { ok: false, conflict: cur };
  }

  async deleteBoard(boardId: string): Promise<void> {
    this.scenes.delete(boardId);
  }

  async getFile(boardId: string, fileId: string): Promise<FileBlob | null> {
    return this.files.get(`${boardId}/${fileId}`) ?? null;
  }

  async putFile(
    boardId: string,
    fileId: string,
    body: FileBlob,
  ): Promise<void> {
    this.files.set(`${boardId}/${fileId}`, body);
  }
}

class FakeBridge implements EditorBridge {
  applied: OrderedExcalidrawElement[] | null = null;
  files = new Map<FileId, BinaryFileData>();
  added: BinaryFileData[] = [];
  constructor(public elements: readonly OrderedExcalidrawElement[]) {}
  getElements(): readonly OrderedExcalidrawElement[] {
    return this.elements;
  }
  getAppState(): AppState {
    return {} as AppState;
  }
  applyRemote(elements: readonly OrderedExcalidrawElement[]): void {
    this.applied = [...elements];
    this.elements = [...elements];
  }
  getFile(fileId: FileId): BinaryFileData | undefined {
    return this.files.get(fileId);
  }
  addFiles(files: BinaryFileData[]): void {
    this.added.push(...files);
    for (const f of files) {
      this.files.set(f.id, f);
    }
  }
}

class FakeBoardStore implements BoardStore {
  data = new Map<string, readonly OrderedExcalidrawElement[]>();
  names = new Map<string, string>();
  removed: string[] = [];
  async load(boardId: string) {
    return this.data.get(boardId) ?? null;
  }
  async save(boardId: string, elements: readonly OrderedExcalidrawElement[]) {
    this.data.set(boardId, elements);
  }
  async remove(boardId: string) {
    this.removed.push(boardId);
    this.data.delete(boardId);
    this.names.delete(boardId);
  }
  getName(boardId: string): string | null {
    return this.names.get(boardId) ?? null;
  }
  upsertBoard(boardId: string, name: string): boolean {
    const changed = this.names.get(boardId) !== name;
    this.names.set(boardId, name);
    return changed;
  }
}

const rect = (id: string): OrderedExcalidrawElement =>
  API.createElement({ type: "rectangle", id }) as OrderedExcalidrawElement;

const imageEl = (id: string, fileId: string): OrderedExcalidrawElement =>
  ({
    ...API.createElement({ type: "image", id, width: 100, height: 100 }),
    fileId: fileId as FileId,
    status: "saved",
  } as unknown as OrderedExcalidrawElement);

const fileData = (id: string, dataURL: string): BinaryFileData => ({
  id: id as FileId,
  dataURL: dataURL as DataURL,
  mimeType: "image/png",
  created: 1,
});

const makeEngine = (
  overrides: Partial<SyncEngineDeps> & { activeBoardId?: string | null },
) => {
  const backend = (overrides.backend as MockBackend) ?? new MockBackend();
  const store = (overrides.store as MemorySyncStore) ?? new MemorySyncStore();
  const bridge = (overrides.bridge as FakeBridge) ?? new FakeBridge([]);
  const boards = (overrides.boards as FakeBoardStore) ?? new FakeBoardStore();
  const key = overrides.getKey;
  const deps: SyncEngineDeps = {
    backend,
    store,
    bridge,
    boards,
    getActiveBoardId: () => overrides.activeBoardId ?? "board-1",
    getKey: key ?? (() => ""),
    now: () => 1000,
    onBoardsChanged: overrides.onBoardsChanged ?? (() => {}),
  };
  return { engine: new SyncEngine(deps), backend, store, bridge, boards };
};

// --- tests -----------------------------------------------------------------

describe("excaliboard crypto", () => {
  it("round-trips elements through encrypt/decrypt", async () => {
    const key = await generateSyncKey();
    const elements = [rect("a"), rect("b")];
    const { iv, ciphertext } = await encryptElements(key, elements);
    const decoded = await decryptElements(
      key,
      fromBase64(toBase64(iv)),
      fromBase64(toBase64(ciphertext)),
    );
    expect(decoded.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("round-trips arbitrary bytes through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});

describe("SyncEngine.pushBoard", () => {
  let key: string;
  beforeEach(async () => {
    key = await generateSyncKey();
  });

  it("creates a board on the server and records last-synced", async () => {
    const bridge = new FakeBridge([rect("a"), rect("b")]);
    const { engine, backend, store } = makeEngine({
      bridge,
      getKey: () => key,
    });

    await engine.pushBoard("board-1");

    expect(backend.putCalls).toHaveLength(1);
    expect(backend.putCalls[0].body.base_version).toBe(0);
    const version = getSceneVersion([rect("a"), rect("b")]); // 2 elements @ v1
    expect(await store.getLastSynced("board-1")).toBe(version);
    expect(backend.scenes.has("board-1")).toBe(true);
  });

  it("skips a redundant push when nothing changed", async () => {
    const bridge = new FakeBridge([rect("a")]);
    const { engine, backend } = makeEngine({ bridge, getKey: () => key });
    await engine.pushBoard("board-1");
    await engine.pushBoard("board-1");
    expect(backend.putCalls).toHaveLength(1);
  });

  it("on 409 reconciles locally and retries with the server's base version", async () => {
    const backend = new MockBackend();
    // Another device already wrote a scene at version R.
    const remote = [rect("server-el")];
    const R = getSceneVersion(remote);
    const enc = await encryptElements(key, remote);
    backend.scenes.set("board-1", {
      sceneVersion: R,
      iv: toBase64(enc.iv),
      ciphertext: toBase64(enc.ciphertext),
    });

    const bridge = new FakeBridge([rect("local-el")]);
    const { engine, store } = makeEngine({
      backend,
      bridge,
      getKey: () => key,
    });

    await engine.pushBoard("board-1"); // base 0 -> 409 -> reconcile -> retry base R

    expect(backend.putCalls.length).toBeGreaterThanOrEqual(2);
    // The retry used the server's current version as the CAS base.
    expect(backend.putCalls[1].body.base_version).toBe(R);
    // The reconciled scene was applied to the live editor.
    expect(bridge.applied).not.toBeNull();
    const finalVersion = backend.scenes.get("board-1")!.sceneVersion;
    expect(await store.getLastSynced("board-1")).toBe(finalVersion);
  });
});

describe("SyncEngine offline outbox", () => {
  it("queues a push on network failure and flushes it when back online", async () => {
    const key = await generateSyncKey();
    const backend = new MockBackend();
    backend.online = false;
    const bridge = new FakeBridge([rect("a")]);
    const { engine, store } = makeEngine({
      backend,
      bridge,
      getKey: () => key,
    });

    await engine.pushBoard("board-1");
    expect(await store.listOutbox()).toHaveLength(1);

    backend.online = true;
    await engine.flushOutbox();

    expect(await store.listOutbox()).toHaveLength(0);
    expect(backend.scenes.has("board-1")).toBe(true);
    expect(await store.getLastSynced("board-1")).toBe(
      getSceneVersion([rect("a")]),
    );
  });
});

describe("SyncEngine.pull", () => {
  let key: string;
  beforeEach(async () => {
    key = await generateSyncKey();
  });

  it("applies a newer server scene to the active board", async () => {
    const backend = new MockBackend();
    const remote = [rect("r1"), rect("r2")];
    const R = getSceneVersion(remote);
    const enc = await encryptElements(key, remote);
    backend.scenes.set("board-1", {
      sceneVersion: R,
      iv: toBase64(enc.iv),
      ciphertext: toBase64(enc.ciphertext),
    });
    backend.indexRows = [
      {
        boardId: "board-1",
        nameIv: null,
        nameCt: null,
        sceneVersion: R,
        deleted: false,
        updatedAt: 5,
      },
    ];

    const bridge = new FakeBridge([]); // active board currently empty
    const { engine, store } = makeEngine({
      backend,
      bridge,
      getKey: () => key,
    });

    await engine.pull();

    expect(bridge.applied).not.toBeNull();
    expect(bridge.applied!.map((e) => e.id).sort()).toEqual(["r1", "r2"]);
    // Converged: our recorded base equals whatever version the server now holds
    // (restore may re-version the merged scene, which we then upload back).
    const serverVersion = backend.scenes.get("board-1")!.sceneVersion;
    expect(await store.getLastSynced("board-1")).toBe(serverVersion);
  });

  it("propagates a remote tombstone by removing the local board", async () => {
    const backend = new MockBackend();
    backend.indexRows = [
      {
        boardId: "gone",
        nameIv: null,
        nameCt: null,
        sceneVersion: 1,
        deleted: true,
        updatedAt: 9,
      },
    ];
    const boards = new FakeBoardStore();
    const { engine, store } = makeEngine({
      backend,
      boards,
      getKey: () => key,
      activeBoardId: "board-1",
    });
    await store.setLastSynced("gone", 1); // we had it locally

    await engine.pull();

    expect(boards.removed).toContain("gone");
    expect(await store.getLastSynced("gone")).toBeNull();
  });

  it("does not re-register a board deleted this session (delete racing the pull)", async () => {
    const backend = new MockBackend();
    const boards = new FakeBoardStore();
    const { engine, store } = makeEngine({
      backend,
      boards,
      getKey: () => key,
      activeBoardId: "other",
    });
    await store.setLastSynced("deleting", 1);

    await engine.softDelete("deleting");

    // the server STILL returns the board as live (its DELETE hasn't landed yet) —
    // the pull must not put it back into the switcher.
    backend.indexRows = [
      {
        boardId: "deleting",
        nameIv: null,
        nameCt: null,
        sceneVersion: 1,
        deleted: false,
        updatedAt: 9,
      },
    ];
    await engine.pull();

    expect(boards.names.has("deleting")).toBe(false);
  });
});

describe("SyncEngine image/file sync", () => {
  let key: string;
  beforeEach(async () => {
    key = await generateSyncKey();
  });

  it("pushes referenced image files the server lacks (encrypted)", async () => {
    const backend = new MockBackend();
    const bridge = new FakeBridge([imageEl("img", "file-1")]);
    bridge.files.set(
      "file-1" as FileId,
      fileData("file-1", "data:image/png;base64,AAAA"),
    );
    const { engine } = makeEngine({ backend, bridge, getKey: () => key });

    await engine.pushBoard("board-1");

    const stored = backend.files.get("board-1/file-1");
    expect(stored).toBeTruthy();
    // round-trips: the stored blob decrypts back to the original dataURL
    const dataURL = await decryptString(
      key,
      fromBase64(stored!.iv),
      fromBase64(stored!.ciphertext),
    );
    expect(dataURL).toBe("data:image/png;base64,AAAA");
  });

  it("skips a file the server already has", async () => {
    const backend = new MockBackend();
    backend.files.set("board-1/file-1", await encryptString(key, "x"));
    const putSpy: string[] = [];
    const origPut = backend.putFile.bind(backend);
    backend.putFile = async (b, f, body) => {
      putSpy.push(f);
      return origPut(b, f, body);
    };
    const bridge = new FakeBridge([imageEl("img", "file-1")]);
    bridge.files.set(
      "file-1" as FileId,
      fileData("file-1", "data:image/png;base64,AAAA"),
    );
    const { engine } = makeEngine({ backend, bridge, getKey: () => key });

    await engine.pushBoard("board-1");
    expect(putSpy).not.toContain("file-1"); // already on the server -> not re-pushed
  });

  it("downloads missing image files into the editor on pull", async () => {
    const backend = new MockBackend();
    const remote = [imageEl("img", "file-2")];
    const R = getSceneVersion(remote);
    const enc = await encryptElements(key, remote);
    backend.scenes.set("board-1", {
      sceneVersion: R,
      iv: toBase64(enc.iv),
      ciphertext: toBase64(enc.ciphertext),
    });
    backend.indexRows = [
      {
        boardId: "board-1",
        nameIv: null,
        nameCt: null,
        sceneVersion: R,
        deleted: false,
        updatedAt: 5,
      },
    ];
    backend.files.set(
      "board-1/file-2",
      await encryptString(key, "data:image/png;base64,BBBB"),
    );

    const bridge = new FakeBridge([]); // editor empty, no file yet
    const { engine } = makeEngine({ backend, bridge, getKey: () => key });

    await engine.pull();

    expect(bridge.added.map((f) => f.id)).toContain("file-2");
    expect(bridge.getFile("file-2" as FileId)?.dataURL).toBe(
      "data:image/png;base64,BBBB",
    );
  });
});

describe("SyncEngine board-list (name) sync", () => {
  let key: string;
  beforeEach(async () => {
    key = await generateSyncKey();
  });

  it("pushes the encrypted board name alongside the scene", async () => {
    const backend = new MockBackend();
    const boards = new FakeBoardStore();
    boards.names.set("board-1", "My Diagram");
    const bridge = new FakeBridge([rect("a")]);
    const { engine } = makeEngine({
      backend,
      bridge,
      boards,
      getKey: () => key,
    });

    await engine.pushBoard("board-1");

    const body = backend.putCalls[0].body;
    expect(body.name_iv).toBeTruthy();
    expect(body.name_ct).toBeTruthy();
    const name = await decryptString(
      key,
      fromBase64(body.name_iv!),
      fromBase64(body.name_ct!),
    );
    expect(name).toBe("My Diagram");
  });

  it("registers server boards into the local switcher on pull (decrypted name)", async () => {
    const backend = new MockBackend();
    const remote = [rect("r1")];
    const R = getSceneVersion(remote);
    const enc = await encryptElements(key, remote);
    backend.scenes.set("b-server", {
      sceneVersion: R,
      iv: toBase64(enc.iv),
      ciphertext: toBase64(enc.ciphertext),
    });
    const nameEnc = await encryptString(key, "Server Board");
    backend.indexRows = [
      {
        boardId: "b-server",
        nameIv: nameEnc.iv,
        nameCt: nameEnc.ciphertext,
        sceneVersion: R,
        deleted: false,
        updatedAt: 5,
      },
    ];
    const boards = new FakeBoardStore();
    let refreshed = 0;
    const { engine } = makeEngine({
      backend,
      boards,
      getKey: () => key,
      activeBoardId: "other",
      onBoardsChanged: () => {
        refreshed++;
      },
    });

    await engine.pull();

    expect(boards.names.get("b-server")).toBe("Server Board");
    expect(refreshed).toBeGreaterThanOrEqual(1);
  });

  it("propagates a rename via pushBoardName even when the scene is unchanged", async () => {
    const backend = new MockBackend();
    const boards = new FakeBoardStore();
    const bridge = new FakeBridge([rect("a")]);
    boards.names.set("board-1", "Old Name");
    const { engine } = makeEngine({
      backend,
      bridge,
      boards,
      getKey: () => key,
    });

    await engine.pushBoard("board-1"); // establish on the server
    boards.names.set("board-1", "New Name");
    await engine.pushBoardName("board-1");

    const last = backend.putCalls[backend.putCalls.length - 1].body;
    const name = await decryptString(
      key,
      fromBase64(last.name_iv!),
      fromBase64(last.name_ct!),
    );
    expect(name).toBe("New Name");
  });
});
