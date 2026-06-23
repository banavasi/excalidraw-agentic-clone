/**
 * LIVE integration test — drives the real RestSyncBackend + real AES-GCM crypto
 * against the deployed server over HTTPS. Gated on env so it never runs in normal
 * CI (it needs the network + the real bearer/key):
 *
 *   EXCALIBOARD_URL=https://excaliboard.shashankshandilya.me \
 *   EXCALIBOARD_BEARER="$(op read 'op://Mithra/excaliboard-sync-auth/static_bearer')" \
 *   EXCALIBOARD_KEY="$(op read 'op://Mithra/excaliboard-e2e-key/key')" \
 *   yarn test:app run excaliboardSync.live
 */
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { getSceneVersion } from "@excalidraw/element";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import {
  RestSyncBackend,
  decryptElements,
  decryptString,
  encryptElements,
  encryptString,
  fromBase64,
  toBase64,
} from "../data/excaliboardSync";

const URL = process.env.EXCALIBOARD_URL;
const BEARER = process.env.EXCALIBOARD_BEARER;
const KEY = process.env.EXCALIBOARD_KEY;

const live = URL && BEARER && KEY ? describe : describe.skip;

live("excaliboard LIVE server integration", () => {
  const backend = new RestSyncBackend({ serverUrl: URL!, bearer: BEARER! });
  const key = KEY!;
  const boardId = `live-test-${Date.now()}`;

  it("scene push → pull round-trips through the live server", async () => {
    const elements = [
      API.createElement({ type: "rectangle", id: "a" }),
      API.createElement({ type: "ellipse", id: "b" }),
    ] as OrderedExcalidrawElement[];
    const { iv, ciphertext } = await encryptElements(key, elements);

    const res = await backend.putBoard(boardId, {
      base_version: 0,
      scene_version: getSceneVersion(elements),
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
    });
    expect(res.ok).toBe(true);

    const scene = await backend.getBoard(boardId);
    expect(scene).toBeTruthy();
    const decoded = await decryptElements(
      key,
      fromBase64(scene!.iv),
      fromBase64(scene!.ciphertext),
    );
    expect(decoded.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("file (image) push → pull round-trips through the live server", async () => {
    const dataURL = "data:image/png;base64,SGVsbG8tZnJvbS1saXZl";
    await backend.putFile(boardId, "live-file", await encryptString(key, dataURL));
    const got = await backend.getFile(boardId, "live-file");
    expect(got).toBeTruthy();
    const back = await decryptString(
      key,
      fromBase64(got!.iv),
      fromBase64(got!.ciphertext),
    );
    expect(back).toBe(dataURL);
  });

  afterAll(async () => {
    await backend.deleteBoard(boardId); // cleanup the tombstone-able test board
  });
});
