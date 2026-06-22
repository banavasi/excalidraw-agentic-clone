import {
  Excalidraw,
  LiveCollaborationTrigger,
  TTDDialogTrigger,
  CaptureUpdateAction,
  reconcileElements,
  useEditorInterface,
  ExcalidrawAPIProvider,
  useExcalidrawAPI,
  exportToBlob,
} from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import {
  CommandPalette,
  DEFAULT_CATEGORIES,
} from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { OverwriteConfirmDialog } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirm";
import { openConfirmModal } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirmState";
import { ShareableLinkDialog } from "@excalidraw/excalidraw/components/ShareableLinkDialog";
import Trans from "@excalidraw/excalidraw/components/Trans";
import {
  APP_NAME,
  EVENT,
  VERSION_TIMEOUT,
  debounce,
  getVersion,
  getFrame,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  isRunningInIframe,
  isDevEnv,
} from "@excalidraw/common";
import polyfill from "@excalidraw/excalidraw/polyfill";
import { useCallback, useEffect, useRef, useState } from "react";
import { getDataURL, loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  GithubIcon,
  XBrandIcon,
  DiscordIcon,
  ExcalLogo,
  usersIcon,
  exportToPlus,
  share,
  youtubeIcon,
} from "@excalidraw/excalidraw/components/icons";
import { isElementLink } from "@excalidraw/element";
import {
  bumpElementVersions,
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { newElementWith } from "@excalidraw/element";
import { getNonDeletedElements } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import clsx from "clsx";
import {
  parseLibraryTokensFromUrl,
  useHandleLibrary,
} from "@excalidraw/excalidraw/data/library";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  BinaryFiles,
  ExcalidrawInitialDataState,
  UIAppState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type { ResolutionType } from "@excalidraw/common/utility-types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import CustomStats from "./CustomStats";
import {
  Provider,
  useAtom,
  useAtomValue,
  useAtomWithInitialValue,
  appJotaiStore,
} from "./app-jotai";
import {
  FIREBASE_STORAGE_PREFIXES,
  isExcalidrawPlusSignedUser,
  STORAGE_KEYS,
  SYNC_BROWSER_TABS_TIMEOUT,
} from "./app_constants";
import Collab, {
  collabAPIAtom,
  isCollaboratingAtom,
  isOfflineAtom,
} from "./collab/Collab";
import { AppFooter } from "./components/AppFooter";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import {
  ExportToExcalidrawPlus,
  exportToExcalidrawPlus,
} from "./components/ExportToExcalidrawPlus";
import { TopErrorBoundary } from "./components/TopErrorBoundary";

import {
  exportToBackend,
  getCollaborationLinkData,
  importFromBackend,
  isCollaborationLink,
} from "./data";

import { updateStaleImageStatuses } from "./data/FileManager";
import { FileStatusStore } from "./data/fileStatusStore";
import { importUsernameFromLocalStorage } from "./data/localStorage";

import { loadFilesFromFirebase } from "./data/firebase";
import {
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
  LocalData,
  localStorageQuotaExceededAtom,
} from "./data/LocalData";
import {
  isBrowserStorageStateNewer,
  markBrowserStateVersionSeen,
} from "./data/tabSync";
import { ShareDialog, shareDialogStateAtom } from "./share/ShareDialog";
import CollabError, { collabErrorIndicatorAtom } from "./collab/CollabError";
import { useHandleAppTheme } from "./useHandleAppTheme";
import { getPreferredLanguage } from "./app-language/language-detector";
import { useAppLangCode } from "./app-language/language-state";
import DebugCanvas, {
  debugRenderer,
  isVisualDebuggerEnabled,
  loadSavedDebugState,
} from "./components/DebugCanvas";
import { AIComponents } from "./components/AI";
import { ExcalidrawPlusIframeExport } from "./ExcalidrawPlusIframeExport";

import "./index.scss";

import { ExcalidrawPlusPromoBanner } from "./components/ExcalidrawPlusPromoBanner";
import { AppSidebar } from "./components/AppSidebar";
import {
  WorkboardSidebar,
  WORKBOARDS_SIDEBAR_NAME,
} from "./workboards/WorkboardSidebar";
import {
  createWorkboard,
  deleteWorkboard,
  duplicateWorkboard,
  ensureWorkboardIndexSync,
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
} from "./workboards/data";

import type { Workboard } from "./workboards/data";

import type { CollabAPI } from "./collab/Collab";

polyfill();

window.EXCALIDRAW_THROTTLE_RENDER = true;

declare global {
  interface BeforeInstallPromptEventChoiceResult {
    outcome: "accepted" | "dismissed";
  }

  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<BeforeInstallPromptEventChoiceResult>;
  }

  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

let pwaEvent: BeforeInstallPromptEvent | null = null;

// Adding a listener outside of the component as it may (?) need to be
// subscribed early to catch the event.
//
// Also note that it will fire only if certain heuristics are met (user has
// used the app for some time, etc.)
window.addEventListener(
  "beforeinstallprompt",
  (event: BeforeInstallPromptEvent) => {
    // prevent Chrome <= 67 from automatically showing the prompt
    event.preventDefault();
    // cache for later use
    pwaEvent = event;
  },
);

let isSelfEmbedding = false;

if (window.self !== window.top) {
  try {
    const parentUrl = new URL(document.referrer);
    const currentUrl = new URL(window.location.href);
    if (parentUrl.origin === currentUrl.origin) {
      isSelfEmbedding = true;
    }
  } catch (error) {
    // ignore
  }
}

const shareableLinkConfirmDialog = {
  title: t("overwriteConfirm.modal.shareableLink.title"),
  description: (
    <Trans
      i18nKey="overwriteConfirm.modal.shareableLink.description"
      bold={(text) => <strong>{text}</strong>}
      br={() => <br />}
    />
  ),
  actionLabel: t("overwriteConfirm.modal.shareableLink.button"),
  color: "danger",
} as const;

const initializeScene = async (opts: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI;
}): Promise<
  { scene: ExcalidrawInitialDataState | null } & (
    | { isExternalScene: true; id: string; key: string }
    | { isExternalScene: false; id?: null; key?: null }
  )
> => {
  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");
  const jsonBackendMatch = window.location.hash.match(
    /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
  );
  const externalUrlMatch = window.location.hash.match(/^#url=(.*)$/);

  // resolve the active workboard and load its scene from IndexedDB (migrating
  // any legacy single-canvas localStorage data into it on first run)
  const activeBoardId = ensureWorkboardIndexSync();
  await migrateLegacyDataIfNeeded(activeBoardId);
  let boardData = await loadWorkboardData(activeBoardId);

  // prefer the synchronous unload/crash recovery snapshot when it is newer than
  // the last persisted IDB save (IDB writes may not finish during unload)
  const recovery = LocalData.readRecovery();
  if (recovery && recovery.boardId === activeBoardId) {
    let lastSavedStamp = -1;
    try {
      lastSavedStamp = JSON.parse(
        localStorage.getItem(getBoardVersionKey(activeBoardId)) || "-1",
      );
    } catch (error: any) {
      console.error(error);
    }
    if (recovery.ts > lastSavedStamp) {
      boardData = { elements: recovery.elements, appState: recovery.appState };
      // persist the recovered scene back to IDB so it's durable going forward
      await saveWorkboardData(activeBoardId, boardData);
    }
    LocalData.clearRecovery();
  }

  const localDataState: {
    elements: readonly ExcalidrawElement[];
    appState: Partial<AppState> | null;
  } = {
    elements: boardData?.elements ?? [],
    appState: boardData?.appState ?? null,
  };

  let scene: Omit<
    RestoredDataState,
    // we're not storing files in the scene database/localStorage, and instead
    // fetch them async from a different store
    "files"
  > & {
    scrollToContent?: boolean;
  } = {
    elements: restoreElements(localDataState?.elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    }),
    appState: restoreAppState(localDataState?.appState, null),
  };

  let roomLinkData = getCollaborationLinkData(window.location.href);
  const isExternalScene = !!(id || jsonBackendMatch || roomLinkData);
  if (isExternalScene) {
    if (
      // don't prompt if scene is empty
      !scene.elements.length ||
      // don't prompt for collab scenes because we don't override local storage
      roomLinkData ||
      // otherwise, prompt whether user wants to override current scene
      (await openConfirmModal(shareableLinkConfirmDialog))
    ) {
      if (jsonBackendMatch) {
        const imported = await importFromBackend(
          jsonBackendMatch[1],
          jsonBackendMatch[2],
        );

        scene = {
          elements: bumpElementVersions(
            restoreElements(imported.elements, null, {
              repairBindings: true,
              deleteInvisibleElements: true,
            }),
            localDataState?.elements,
          ),
          appState: restoreAppState(
            imported.appState,
            // local appState when importing from backend to ensure we restore
            // localStorage user settings which we do not persist on server.
            localDataState?.appState,
          ),
        };
      }
      scene.scrollToContent = true;
      if (!roomLinkData) {
        window.history.replaceState({}, APP_NAME, window.location.origin);
      }
    } else {
      // https://github.com/excalidraw/excalidraw/issues/1919
      if (document.hidden) {
        return new Promise((resolve, reject) => {
          window.addEventListener(
            "focus",
            () => initializeScene(opts).then(resolve).catch(reject),
            {
              once: true,
            },
          );
        });
      }

      roomLinkData = null;
      window.history.replaceState({}, APP_NAME, window.location.origin);
    }
  } else if (externalUrlMatch) {
    window.history.replaceState({}, APP_NAME, window.location.origin);

    const url = externalUrlMatch[1];
    try {
      const request = await fetch(window.decodeURIComponent(url));
      const data = await loadFromBlob(await request.blob(), null, null);
      if (
        !scene.elements.length ||
        (await openConfirmModal(shareableLinkConfirmDialog))
      ) {
        return { scene: data, isExternalScene };
      }
    } catch (error: any) {
      return {
        scene: {
          appState: {
            errorMessage: t("alerts.invalidSceneUrl"),
          },
        },
        isExternalScene,
      };
    }
  }

  if (roomLinkData && opts.collabAPI) {
    const { excalidrawAPI } = opts;

    const scene = await opts.collabAPI.startCollaboration(roomLinkData);

    return {
      // when collaborating, the state may have already been updated at this
      // point (we may have received updates from other clients), so reconcile
      // elements and appState with existing state
      scene: {
        ...scene,
        appState: {
          ...restoreAppState(
            {
              ...scene?.appState,
              theme: localDataState?.appState?.theme || scene?.appState?.theme,
            },
            excalidrawAPI.getAppState(),
          ),
          // necessary if we're invoking from a hashchange handler which doesn't
          // go through App.initializeScene() that resets this flag
          isLoading: false,
        },
        elements: reconcileElements(
          scene?.elements || [],
          excalidrawAPI.getSceneElementsIncludingDeleted() as RemoteExcalidrawElement[],
          excalidrawAPI.getAppState(),
        ),
      },
      isExternalScene: true,
      id: roomLinkData.roomId,
      key: roomLinkData.roomKey,
    };
  } else if (scene) {
    return isExternalScene && jsonBackendMatch
      ? {
          scene,
          isExternalScene,
          id: jsonBackendMatch[1],
          key: jsonBackendMatch[2],
        }
      : { scene, isExternalScene: false };
  }
  return { scene: null, isExternalScene: false };
};

const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();

  const [errorMessage, setErrorMessage] = useState("");
  const isCollabDisabled = isRunningInIframe();

  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [langCode, setLangCode] = useAppLangCode();

  const editorInterface = useEditorInterface();

  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  const debugCanvasRef = useRef<HTMLCanvasElement>(null);

  // workboards (multi-canvas) state
  // ---------------------------------------------------------------------------
  // `activeBoardIdRef` is the source of truth read by the (hot-path) onChange
  // save; the `activeBoardId` state mirror drives the sidebar UI. Initialized
  // synchronously so the active board id exists before the first save.
  const activeBoardIdRef = useRef<string | null>(null);
  if (activeBoardIdRef.current === null) {
    activeBoardIdRef.current = ensureWorkboardIndexSync();
  }
  const [activeBoardId, setActiveBoardId] = useState<string>(
    activeBoardIdRef.current,
  );
  const [workboards, setWorkboards] = useState<Workboard[]>(() =>
    loadWorkboardIndex(),
  );
  const [workboardThumbnails, setWorkboardThumbnails] = useState<
    Record<string, string>
  >({});
  // monotonic token to ignore stale board-loads when switches overlap
  const boardSwitchSeqRef = useRef(0);

  useEffect(() => {
    trackEvent("load", "frame", getFrame());
    // Delayed so that the app has a time to load the latest SW
    setTimeout(() => {
      trackEvent("load", "version", getVersion());
    }, VERSION_TIMEOUT);
  }, []);

  const [, setShareDialogState] = useAtom(shareDialogStateAtom);
  const [collabAPI] = useAtom(collabAPIAtom);
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    return isCollaborationLink(window.location.href);
  });
  const collabError = useAtomValue(collabErrorIndicatorAtom);

  useHandleLibrary({
    excalidrawAPI,
    adapter: LibraryIndexedDBAdapter,
    // TODO maybe remove this in several months (shipped: 24-03-11)
    migrationAdapter: LibraryLocalStorageMigrationAdapter,
  });

  const [, forceRefresh] = useState(false);

  useEffect(() => {
    if (isDevEnv()) {
      const debugState = loadSavedDebugState();

      if (debugState.enabled && !window.visualDebug) {
        window.visualDebug = {
          data: [],
        };
      } else {
        delete window.visualDebug;
      }
      forceRefresh((prev) => !prev);
    }
  }, [excalidrawAPI]);

  // ---------------------------------------------------------------------------
  // Hoisted loadImages
  // ---------------------------------------------------------------------------
  const loadImages = useCallback(
    (data: ResolutionType<typeof initializeScene>, isInitialLoad = false) => {
      if (!data.scene || !excalidrawAPI) {
        return;
      }

      if (collabAPI?.isCollaborating()) {
        if (data.scene.elements) {
          collabAPI
            .fetchImageFilesFromFirebase({
              elements: data.scene.elements,
              forceFetchFiles: true,
            })
            .then(({ loadedFiles, erroredFiles }) => {
              excalidrawAPI.addFiles(loadedFiles);
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
              });
            });
        }
      } else {
        const fileIds =
          data.scene.elements?.reduce((acc, element) => {
            if (isInitializedImageElement(element)) {
              return acc.concat(element.fileId);
            }
            return acc;
          }, [] as FileId[]) || [];

        if (data.isExternalScene) {
          if (fileIds.length) {
            // Direct Firebase call (not through FileManager), so track manually
            FileStatusStore.updateStatuses(
              fileIds.map((id) => [id, "loading"]),
            );
          }
          loadFilesFromFirebase(
            `${FIREBASE_STORAGE_PREFIXES.shareLinkFiles}/${data.id}`,
            data.key,
            fileIds,
          ).then(({ loadedFiles, erroredFiles }) => {
            excalidrawAPI.addFiles(loadedFiles);
            updateStaleImageStatuses({
              excalidrawAPI,
              erroredFiles,
              elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
            });
            FileStatusStore.updateStatuses([
              ...loadedFiles.map((f) => [f.id, "loaded"] as [FileId, "loaded"]),
              ...[...erroredFiles.keys()].map(
                (id) => [id, "error"] as [FileId, "error"],
              ),
            ]);
          });
        } else if (isInitialLoad) {
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(async ({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
          // on fresh load, clear unused files from IDB (from previous
          // session). Board-aware: retain files referenced by ANY workboard so
          // an image shared with another board isn't deleted. Fail CLOSED: if
          // the cross-board reference union couldn't be fully computed, skip
          // cleanup rather than risk deleting a still-referenced image.
          listAllReferencedFileIds().then(
            ({ fileIds: allBoardFileIds, complete }) => {
              if (!complete) {
                return;
              }
              LocalData.fileStorage.clearObsoleteFiles({
                currentFileIds: [...new Set([...fileIds, ...allBoardFileIds])],
              });
            },
          );
        }
      }
    },
    [collabAPI, excalidrawAPI],
  );

  useEffect(() => {
    if (!excalidrawAPI || (!isCollabDisabled && !collabAPI)) {
      return;
    }

    initializeScene({ collabAPI, excalidrawAPI }).then(async (data) => {
      loadImages(data, /* isInitialLoad */ true);
      initialStatePromiseRef.current.promise.resolve(data.scene);
      // mark the boot board's stamp as seen so the first focus/visibility
      // syncData doesn't re-import it over edits made before the first save
      const bootBoardId = activeBoardIdRef.current;
      if (bootBoardId) {
        markBrowserStateVersionSeen(getBoardVersionKey(bootBoardId));
      }
    });

    const onHashChange = async (event: HashChangeEvent) => {
      event.preventDefault();
      const libraryUrlTokens = parseLibraryTokensFromUrl();
      if (!libraryUrlTokens) {
        if (
          collabAPI?.isCollaborating() &&
          !isCollaborationLink(window.location.href)
        ) {
          collabAPI.stopCollaboration(false);
        }
        excalidrawAPI.updateScene({ appState: { isLoading: true } });

        initializeScene({ collabAPI, excalidrawAPI }).then((data) => {
          loadImages(data);
          if (data.scene) {
            excalidrawAPI.updateScene({
              elements: restoreElements(data.scene.elements, null, {
                repairBindings: true,
              }),
              appState: restoreAppState(data.scene.appState, null),
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            });
          }
        });
      }
    };

    const syncData = debounce(async () => {
      if (isTestEnv()) {
        return;
      }
      if (
        !document.hidden &&
        ((collabAPI && !collabAPI.isCollaborating()) || isCollabDisabled)
      ) {
        const boardId = activeBoardIdRef.current;
        // don't sync if local state is newer or identical to browser state.
        // Data-state stamps are per-board, so another tab editing a *different*
        // board won't trigger a (clobbering) re-import here.
        if (
          boardId &&
          isBrowserStorageStateNewer(getBoardVersionKey(boardId))
        ) {
          const boardData = await loadWorkboardData(boardId);
          // the user may have switched boards while the IDB read was in flight;
          // bail so we never apply this board's data onto a different active
          // board (which onChange would then persist into the wrong board)
          if (activeBoardIdRef.current !== boardId) {
            return;
          }
          const username = importUsernameFromLocalStorage();
          setLangCode(getPreferredLanguage());
          if (boardData) {
            excalidrawAPI.updateScene({
              elements: restoreElements(boardData.elements, null, {
                repairBindings: true,
              }),
              appState: restoreAppState(boardData.appState ?? null, null),
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
          LibraryIndexedDBAdapter.load().then((data) => {
            if (data) {
              excalidrawAPI.updateLibrary({
                libraryItems: data.libraryItems,
              });
            }
          });
          collabAPI?.setUsername(username || "");
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
          const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
          const currFiles = excalidrawAPI.getFiles();
          const fileIds =
            elements?.reduce((acc, element) => {
              if (
                isInitializedImageElement(element) &&
                // only load and update images that aren't already loaded
                !currFiles[element.fileId]
              ) {
                return acc.concat(element.fileId);
              }
              return acc;
            }, [] as FileId[]) || [];
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    // synchronously snapshot the active board to localStorage; IDB writes
    // aren't guaranteed to finish during unload (see LocalData.writeRecovery)
    const writeActiveRecovery = () => {
      const boardId = activeBoardIdRef.current;
      if (boardId && excalidrawAPI && !collabAPI?.isCollaborating()) {
        LocalData.writeRecovery(
          boardId,
          excalidrawAPI.getSceneElementsIncludingDeleted(),
          excalidrawAPI.getAppState(),
        );
      }
    };

    const onUnload = () => {
      writeActiveRecovery();
      LocalData.flushSave();
    };

    const visibilityChange = (event: FocusEvent | Event) => {
      if (event.type === EVENT.BLUR || document.hidden) {
        writeActiveRecovery();
        LocalData.flushSave();
      }
      if (
        event.type === EVENT.VISIBILITY_CHANGE ||
        event.type === EVENT.FOCUS
      ) {
        syncData();
      }
    };

    window.addEventListener(EVENT.HASHCHANGE, onHashChange, false);
    window.addEventListener(EVENT.UNLOAD, onUnload, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false);
      window.removeEventListener(EVENT.UNLOAD, onUnload, false);
      window.removeEventListener(EVENT.BLUR, visibilityChange, false);
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false);
      document.removeEventListener(
        EVENT.VISIBILITY_CHANGE,
        visibilityChange,
        false,
      );
    };
  }, [isCollabDisabled, collabAPI, excalidrawAPI, setLangCode, loadImages]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      const boardId = activeBoardIdRef.current;
      if (boardId && excalidrawAPI && !collabAPI?.isCollaborating()) {
        LocalData.writeRecovery(
          boardId,
          excalidrawAPI.getSceneElementsIncludingDeleted(),
          excalidrawAPI.getAppState(),
        );
      }
      LocalData.flushSave();

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
          preventUnload(event);
        } else {
          console.warn(
            "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
          );
        }
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI, collabAPI]);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (collabAPI?.isCollaborating()) {
      collabAPI.syncElements(elements);
    }

    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!LocalData.isSavePaused()) {
      LocalData.save(
        activeBoardIdRef.current,
        elements,
        appState,
        files,
        () => {
          if (excalidrawAPI) {
            let didChange = false;

            const elements = excalidrawAPI
              .getSceneElementsIncludingDeleted()
              .map((element) => {
                if (
                  LocalData.fileStorage.shouldUpdateImageElementStatus(element)
                ) {
                  const newElement = newElementWith(element, {
                    status: "saved",
                  });
                  if (newElement !== element) {
                    didChange = true;
                  }
                  return newElement;
                }
                return element;
              });

            if (didChange) {
              excalidrawAPI.updateScene({
                elements,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
        },
      );
    }

    // Render the debug scene if the debug canvas is available
    if (debugCanvasRef.current && excalidrawAPI) {
      debugRenderer(
        debugCanvasRef.current,
        appState,
        elements,
        window.devicePixelRatio,
      );
    }
  };

  // workboards (multi-canvas) handlers
  // ---------------------------------------------------------------------------

  const refreshWorkboards = useCallback(() => {
    setWorkboards(loadWorkboardIndex());
  }, []);

  // keep the board list in sync with create/rename/delete done in other tabs
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEYS.WORKBOARDS_INDEX) {
        refreshWorkboards();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshWorkboards]);

  /** Loads a board's referenced image files into the live scene. */
  const loadBoardImages = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      if (!excalidrawAPI) {
        return;
      }
      const fileIds = elements.reduce((acc, element) => {
        if (isInitializedImageElement(element)) {
          acc.push(element.fileId);
        }
        return acc;
      }, [] as FileId[]);
      if (!fileIds.length) {
        return;
      }
      LocalData.fileStorage
        .getFiles(fileIds)
        .then(({ loadedFiles, erroredFiles }) => {
          if (loadedFiles.length) {
            excalidrawAPI.addFiles(loadedFiles);
          }
          updateStaleImageStatuses({
            excalidrawAPI,
            erroredFiles,
            elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
          });
          // reconcile image element status (pending -> saved) for files now in
          // storage; the debounced-save callback that normally does this is not
          // run on a board load.
          let didChange = false;
          const reconciled = excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .map((element) => {
              if (
                LocalData.fileStorage.shouldUpdateImageElementStatus(element)
              ) {
                const next = newElementWith(element, { status: "saved" });
                if (next !== element) {
                  didChange = true;
                }
                return next;
              }
              return element;
            });
          if (didChange) {
            excalidrawAPI.updateScene({
              elements: reconciled,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
        });
    },
    [excalidrawAPI],
  );

  /** Best-effort PNG thumbnail for a board (non-blocking). */
  const captureWorkboardThumbnail = useCallback(
    async (
      boardId: string,
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      try {
        const visibleElements = getNonDeletedElements(elements);
        if (!visibleElements.length) {
          return;
        }
        const blob = await exportToBlob({
          elements: visibleElements,
          appState: { ...appState, exportBackground: true },
          files: files ?? {},
          mimeType: "image/png",
          maxWidthOrHeight: 320,
        });
        const dataURL = await getDataURL(blob);
        await saveWorkboardThumbnail(boardId, dataURL);
        setWorkboardThumbnails((prev) => ({ ...prev, [boardId]: dataURL }));
      } catch (error: any) {
        console.error("workboard thumbnail capture failed", error);
      }
    },
    [],
  );

  /** Persists the active board immediately (awaited, undebounced) so it can't
   * race a board switch. */
  const persistActiveBoard = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }
    const boardId = activeBoardIdRef.current;
    if (!boardId) {
      return;
    }
    LocalData.cancelSave(boardId);
    const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const appState = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();
    await LocalData.saveImmediately(boardId, elements, appState, files);
    captureWorkboardThumbnail(boardId, elements, appState, files);
  }, [excalidrawAPI, captureWorkboardThumbnail]);

  /** Swaps the live scene to the given board, isolating undo history so undo
   * can't cross board boundaries. */
  const loadBoardIntoEditor = useCallback(
    async (boardId: string) => {
      if (!excalidrawAPI) {
        return;
      }
      // guard against overlapping switches: only the latest load may apply
      const seq = ++boardSwitchSeqRef.current;
      const data = await loadWorkboardData(boardId);
      if (seq !== boardSwitchSeqRef.current) {
        return;
      }
      setActiveWorkboardId(boardId);
      activeBoardIdRef.current = boardId;
      setActiveBoardId(boardId);
      const currentAppState = excalidrawAPI.getAppState();
      excalidrawAPI.history.clear();
      excalidrawAPI.updateScene({
        elements: restoreElements(data?.elements ?? [], null, {
          repairBindings: true,
        }),
        appState: {
          ...restoreAppState(data?.appState ?? null, null),
          // preserve session-global UI that shouldn't reset per board
          theme: currentAppState.theme,
          openSidebar: currentAppState.openSidebar,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      // mark the just-loaded board's stamp as seen so a focus/visibility
      // syncData doesn't re-import it over unsaved post-load edits
      markBrowserStateVersionSeen(getBoardVersionKey(boardId));
      loadBoardImages(data?.elements ?? []);
    },
    [excalidrawAPI, loadBoardImages],
  );

  const guardAgainstCollab = useCallback(() => {
    if (collabAPI?.isCollaborating()) {
      excalidrawAPI?.setToast({
        message: "Stop collaborating to switch workboards.",
        closable: true,
      });
      return true;
    }
    return false;
  }, [collabAPI, excalidrawAPI]);

  const handleSwitchBoard = useCallback(
    async (targetId: string) => {
      if (!excalidrawAPI || targetId === activeBoardIdRef.current) {
        return;
      }
      if (guardAgainstCollab()) {
        return;
      }
      await persistActiveBoard();
      await loadBoardIntoEditor(targetId);
      refreshWorkboards();
    },
    [
      excalidrawAPI,
      guardAgainstCollab,
      persistActiveBoard,
      loadBoardIntoEditor,
      refreshWorkboards,
    ],
  );

  const handleCreateBoard = useCallback(async () => {
    if (!excalidrawAPI || guardAgainstCollab()) {
      return;
    }
    await persistActiveBoard();
    const board = createWorkboard();
    await loadBoardIntoEditor(board.id);
    refreshWorkboards();
  }, [
    excalidrawAPI,
    guardAgainstCollab,
    persistActiveBoard,
    loadBoardIntoEditor,
    refreshWorkboards,
  ]);

  const handleRenameBoard = useCallback(
    (id: string) => {
      const board = loadWorkboardIndex().find((b) => b.id === id);
      const nextName = window.prompt("Rename workboard", board?.name ?? "");
      if (nextName == null) {
        return;
      }
      const trimmed = nextName.trim();
      if (!trimmed) {
        return;
      }
      setWorkboards(renameWorkboard(id, trimmed));
      if (id === activeBoardIdRef.current && excalidrawAPI) {
        excalidrawAPI.updateScene({
          appState: { name: trimmed },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    },
    [excalidrawAPI],
  );

  const handleDuplicateBoard = useCallback(
    async (id: string) => {
      if (id === activeBoardIdRef.current) {
        // make sure the latest edits are persisted before copying
        await persistActiveBoard();
      }
      const copy = await duplicateWorkboard(id);
      refreshWorkboards();
      if (copy) {
        const thumbnail = await loadWorkboardThumbnail(copy.id);
        if (thumbnail) {
          setWorkboardThumbnails((prev) => ({ ...prev, [copy.id]: thumbnail }));
        }
      }
    },
    [persistActiveBoard, refreshWorkboards],
  );

  const handleDeleteBoard = useCallback(
    async (id: string) => {
      // deleting the active board swaps the live scene (loadBoardIntoEditor),
      // which must not happen mid-collaboration
      if (id === activeBoardIdRef.current && guardAgainstCollab()) {
        return;
      }
      const boards = loadWorkboardIndex();
      if (boards.length <= 1) {
        return;
      }
      const board = boards.find((b) => b.id === id);
      if (
        !window.confirm(
          `Delete workboard "${board?.name ?? ""}"? This can't be undone.`,
        )
      ) {
        return;
      }
      // cancel any pending debounced save for this board so a late write can't
      // resurrect an orphan IDB entry after deletion
      LocalData.cancelSave(id);
      const remaining = await deleteWorkboard(id);
      setWorkboards(remaining);
      setWorkboardThumbnails((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (id === activeBoardIdRef.current && remaining.length) {
        await loadBoardIntoEditor(remaining[0].id);
      }
    },
    [guardAgainstCollab, loadBoardIntoEditor],
  );

  // import a .excalidraw / .png / .svg / .json file as a NEW workboard
  // (non-destructive — the current board is preserved). This is the bridge
  // from the /excaliboard skill (and any external file) into the workspace.
  const handleImportBoard = useCallback(
    async (file: File) => {
      if (!excalidrawAPI || guardAgainstCollab()) {
        return;
      }
      let data;
      try {
        data = await loadFromBlob(file, null, null);
      } catch (error: any) {
        console.error(error);
        excalidrawAPI.setToast({
          message: "Couldn't read that file as an Excalidraw scene.",
          closable: true,
        });
        return;
      }
      // persist the current board, then create + load the imported one
      await persistActiveBoard();
      const name =
        file.name.replace(/\.(excalidraw|json|png|svg)$/i, "").trim() ||
        undefined;
      const board = createWorkboard(name);
      const elements = data.elements ?? [];
      await saveWorkboardData(board.id, {
        elements,
        appState: data.appState ?? null,
      });
      if (data.files && Object.keys(data.files).length) {
        await LocalData.fileStorage.saveFiles({ elements, files: data.files });
      }
      await loadBoardIntoEditor(board.id);
      refreshWorkboards();
      excalidrawAPI.setToast({
        message: `Imported "${board.name}"`,
        closable: true,
      });
    },
    [
      excalidrawAPI,
      guardAgainstCollab,
      persistActiveBoard,
      loadBoardIntoEditor,
      refreshWorkboards,
    ],
  );

  // load persisted thumbnails for the board list
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        workboards.map(
          async (board) =>
            [board.id, await loadWorkboardThumbnail(board.id)] as const,
        ),
      );
      if (cancelled) {
        return;
      }
      setWorkboardThumbnails((prev) => {
        const next = { ...prev };
        for (const [id, url] of entries) {
          if (url) {
            next[id] = url;
          }
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [workboards]);

  const [latestShareableLink, setLatestShareableLink] = useState<string | null>(
    null,
  );

  const onExportToBackend = async (
    exportedElements: readonly NonDeletedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => {
    if (exportedElements.length === 0) {
      throw new Error(t("alerts.cannotExportEmptyCanvas"));
    }
    try {
      const { url, errorMessage } = await exportToBackend(
        exportedElements,
        {
          ...appState,
          viewBackgroundColor: appState.exportBackground
            ? appState.viewBackgroundColor
            : getDefaultAppState().viewBackgroundColor,
        },
        files,
      );

      if (errorMessage) {
        throw new Error(errorMessage);
      }

      if (url) {
        setLatestShareableLink(url);
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        const { width, height } = appState;
        console.error(error, {
          width,
          height,
          devicePixelRatio: window.devicePixelRatio,
        });
        throw new Error(error.message);
      }
    }
  };

  const renderCustomStats = (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: UIAppState,
  ) => {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI!.setToast({ message })}
        appState={appState}
        elements={elements}
      />
    );
  };

  const isOffline = useAtomValue(isOfflineAtom);

  const localStorageQuotaExceeded = useAtomValue(localStorageQuotaExceededAtom);

  const onCollabDialogOpen = useCallback(
    () => setShareDialogState({ isOpen: true, type: "collaborationOnly" }),
    [setShareDialogState],
  );

  // ---------------------------------------------------------------------------
  // onExport — intercepts file save to wait for pending image loads
  // ---------------------------------------------------------------------------
  const onExport: Required<ExcalidrawProps>["onExport"] = useCallback(
    async function* () {
      let snapshot = FileStatusStore.getSnapshot();
      const { pending, total } = FileStatusStore.getPendingCount(
        snapshot.value,
      );
      if (pending === 0) {
        return;
      }

      // Yield initial progress
      yield {
        type: "progress",
        progress: (total - pending) / total,
        message: `Loading images (${total - pending}/${total})...`,
      };

      // Wait for all pending images to finish
      while (true) {
        snapshot = await FileStatusStore.pull(snapshot.version);
        const { pending: nowPending, total: nowTotal } =
          FileStatusStore.getPendingCount(snapshot.value);

        yield {
          type: "progress",
          progress: (nowTotal - nowPending) / nowTotal,
          message: `Loading images (${nowTotal - nowPending}/${nowTotal})...`,
        };

        if (nowPending === 0) {
          await new Promise((r) => setTimeout(r, 500));
          yield {
            type: "progress",
            message: `Preparing export...`,
          };
          return;
        }
      }
    },
    [],
  );

  // const onExport = () => {
  //   return new Promise((r) => setTimeout(r, 2500));
  //   // console.log("onExport");
  // };

  // browsers generally prevent infinite self-embedding, there are
  // cases where it still happens, and while we disallow self-embedding
  // by not whitelisting our own origin, this serves as an additional guard
  if (isSelfEmbedding) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          height: "100%",
        }}
      >
        <h1>I'm not a pretzel!</h1>
      </div>
    );
  }

  const ExcalidrawPlusCommand = {
    label: "Excalidraw+",
    category: DEFAULT_CATEGORIES.links,
    predicate: true,
    icon: <div style={{ width: 14 }}>{ExcalLogo}</div>,
    keywords: ["plus", "cloud", "server"],
    perform: () => {
      window.open(
        `${
          import.meta.env.VITE_APP_PLUS_LP
        }/plus?utm_source=excalidraw&utm_medium=app&utm_content=command_palette`,
        "_blank",
      );
    },
  };
  const ExcalidrawPlusAppCommand = {
    label: "Sign up",
    category: DEFAULT_CATEGORIES.links,
    predicate: true,
    icon: <div style={{ width: 14 }}>{ExcalLogo}</div>,
    keywords: [
      "excalidraw",
      "plus",
      "cloud",
      "server",
      "signin",
      "login",
      "signup",
    ],
    perform: () => {
      window.open(
        `${
          import.meta.env.VITE_APP_PLUS_APP
        }?utm_source=excalidraw&utm_medium=app&utm_content=command_palette`,
        "_blank",
      );
    },
  };

  return (
    <div
      style={{ height: "100%" }}
      className={clsx("excalidraw-app", {
        "is-collaborating": isCollaborating,
      })}
    >
      <Excalidraw
        onChange={onChange}
        onExport={onExport}
        initialData={initialStatePromiseRef.current.promise}
        isCollaborating={isCollaborating}
        onPointerUpdate={collabAPI?.onPointerUpdate}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: {
              onExportToBackend,
              renderCustomUI: excalidrawAPI
                ? (elements, appState, files) => {
                    return (
                      <ExportToExcalidrawPlus
                        elements={elements}
                        appState={appState}
                        files={files}
                        name={excalidrawAPI.getName()}
                        onError={(error) => {
                          excalidrawAPI?.updateScene({
                            appState: {
                              errorMessage: error.message,
                            },
                          });
                        }}
                        onSuccess={() => {
                          excalidrawAPI.updateScene({
                            appState: { openDialog: null },
                          });
                        }}
                      />
                    );
                  }
                : undefined,
            },
          },
        }}
        langCode={langCode}
        renderCustomStats={renderCustomStats}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
        theme={editorTheme}
        onThemeChange={setAppTheme}
        renderTopRightUI={(isMobile) => {
          if (isMobile || !collabAPI || isCollabDisabled) {
            return null;
          }

          return (
            <div className="excalidraw-ui-top-right">
              {excalidrawAPI?.getEditorInterface().formFactor === "desktop" && (
                <ExcalidrawPlusPromoBanner
                  isSignedIn={isExcalidrawPlusSignedUser}
                />
              )}

              {collabError.message && <CollabError collabError={collabError} />}
              <LiveCollaborationTrigger
                isCollaborating={isCollaborating}
                onSelect={() =>
                  setShareDialogState({ isOpen: true, type: "share" })
                }
                editorInterface={editorInterface}
              />
            </div>
          );
        }}
        onLinkOpen={(element, event) => {
          if (element.link && isElementLink(element.link)) {
            event.preventDefault();
            excalidrawAPI?.scrollToContent(element.link, { animate: true });
          }
        }}
      >
        <AppMainMenu
          onCollabDialogOpen={onCollabDialogOpen}
          isCollaborating={isCollaborating}
          isCollabEnabled={!isCollabDisabled}
          theme={appTheme}
          refresh={() => forceRefresh((prev) => !prev)}
          onWorkboards={() =>
            excalidrawAPI?.toggleSidebar({ name: WORKBOARDS_SIDEBAR_NAME })
          }
        />
        <AppWelcomeScreen
          onCollabDialogOpen={onCollabDialogOpen}
          isCollabEnabled={!isCollabDisabled}
        />
        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
          {excalidrawAPI && (
            <OverwriteConfirmDialog.Action
              title={t("overwriteConfirm.action.excalidrawPlus.title")}
              actionLabel={t("overwriteConfirm.action.excalidrawPlus.button")}
              onClick={() => {
                exportToExcalidrawPlus(
                  excalidrawAPI.getSceneElements(),
                  excalidrawAPI.getAppState(),
                  excalidrawAPI.getFiles(),
                  excalidrawAPI.getName(),
                );
              }}
            >
              {t("overwriteConfirm.action.excalidrawPlus.description")}
            </OverwriteConfirmDialog.Action>
          )}
        </OverwriteConfirmDialog>
        <AppFooter onChange={() => excalidrawAPI?.refresh()} />
        {excalidrawAPI && <AIComponents excalidrawAPI={excalidrawAPI} />}

        <TTDDialogTrigger />
        {isCollaborating && isOffline && (
          <div className="alertalert--warning">
            {t("alerts.collabOfflineWarning")}
          </div>
        )}
        {localStorageQuotaExceeded && (
          <div className="alert alert--danger">
            {t("alerts.localStorageQuotaExceeded")}
          </div>
        )}
        {latestShareableLink && (
          <ShareableLinkDialog
            link={latestShareableLink}
            onCloseRequest={() => setLatestShareableLink(null)}
            setErrorMessage={setErrorMessage}
          />
        )}
        {excalidrawAPI && !isCollabDisabled && (
          <Collab excalidrawAPI={excalidrawAPI} />
        )}

        <ShareDialog
          collabAPI={collabAPI}
          onExportToBackend={async () => {
            if (excalidrawAPI) {
              try {
                await onExportToBackend(
                  excalidrawAPI.getSceneElements(),
                  excalidrawAPI.getAppState(),
                  excalidrawAPI.getFiles(),
                );
              } catch (error: any) {
                setErrorMessage(error.message);
              }
            }
          }}
        />

        <AppSidebar />
        <WorkboardSidebar
          boards={workboards}
          activeBoardId={activeBoardId}
          thumbnails={workboardThumbnails}
          disabled={isCollaborating}
          onSwitch={handleSwitchBoard}
          onCreate={handleCreateBoard}
          onImport={handleImportBoard}
          onRename={handleRenameBoard}
          onDuplicate={handleDuplicateBoard}
          onDelete={handleDeleteBoard}
        />

        {errorMessage && (
          <ErrorDialog onClose={() => setErrorMessage("")}>
            {errorMessage}
          </ErrorDialog>
        )}

        <CommandPalette
          customCommandPaletteItems={[
            {
              label: t("labels.liveCollaboration"),
              category: DEFAULT_CATEGORIES.app,
              keywords: [
                "team",
                "multiplayer",
                "share",
                "public",
                "session",
                "invite",
              ],
              icon: usersIcon,
              perform: () => {
                setShareDialogState({
                  isOpen: true,
                  type: "collaborationOnly",
                });
              },
            },
            {
              label: t("roomDialog.button_stopSession"),
              category: DEFAULT_CATEGORIES.app,
              predicate: () => !!collabAPI?.isCollaborating(),
              keywords: [
                "stop",
                "session",
                "end",
                "leave",
                "close",
                "exit",
                "collaboration",
              ],
              perform: () => {
                if (collabAPI) {
                  collabAPI.stopCollaboration();
                  if (!collabAPI.isCollaborating()) {
                    setShareDialogState({ isOpen: false });
                  }
                }
              },
            },
            {
              label: t("labels.share"),
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              icon: share,
              keywords: [
                "link",
                "shareable",
                "readonly",
                "export",
                "publish",
                "snapshot",
                "url",
                "collaborate",
                "invite",
              ],
              perform: async () => {
                setShareDialogState({ isOpen: true, type: "share" });
              },
            },
            {
              label: "GitHub",
              icon: GithubIcon,
              category: DEFAULT_CATEGORIES.links,
              predicate: true,
              keywords: [
                "issues",
                "bugs",
                "requests",
                "report",
                "features",
                "social",
                "community",
              ],
              perform: () => {
                window.open(
                  "https://github.com/excalidraw/excalidraw",
                  "_blank",
                  "noopener noreferrer",
                );
              },
            },
            {
              label: t("labels.followUs"),
              icon: XBrandIcon,
              category: DEFAULT_CATEGORIES.links,
              predicate: true,
              keywords: ["twitter", "contact", "social", "community"],
              perform: () => {
                window.open(
                  "https://x.com/excalidraw",
                  "_blank",
                  "noopener noreferrer",
                );
              },
            },
            {
              label: t("labels.discordChat"),
              category: DEFAULT_CATEGORIES.links,
              predicate: true,
              icon: DiscordIcon,
              keywords: [
                "chat",
                "talk",
                "contact",
                "bugs",
                "requests",
                "report",
                "feedback",
                "suggestions",
                "social",
                "community",
              ],
              perform: () => {
                window.open(
                  "https://discord.gg/UexuTaE",
                  "_blank",
                  "noopener noreferrer",
                );
              },
            },
            {
              label: "YouTube",
              icon: youtubeIcon,
              category: DEFAULT_CATEGORIES.links,
              predicate: true,
              keywords: ["features", "tutorials", "howto", "help", "community"],
              perform: () => {
                window.open(
                  "https://youtube.com/@excalidraw",
                  "_blank",
                  "noopener noreferrer",
                );
              },
            },
            ...(isExcalidrawPlusSignedUser
              ? [
                  {
                    ...ExcalidrawPlusAppCommand,
                    label: "Sign in / Go to Excalidraw+",
                  },
                ]
              : [ExcalidrawPlusCommand, ExcalidrawPlusAppCommand]),

            {
              label: t("overwriteConfirm.action.excalidrawPlus.button"),
              category: DEFAULT_CATEGORIES.export,
              icon: exportToPlus,
              predicate: true,
              keywords: ["plus", "export", "save", "backup"],
              perform: () => {
                if (excalidrawAPI) {
                  exportToExcalidrawPlus(
                    excalidrawAPI.getSceneElements(),
                    excalidrawAPI.getAppState(),
                    excalidrawAPI.getFiles(),
                    excalidrawAPI.getName(),
                  );
                }
              },
            },
            {
              label: t("labels.installPWA"),
              category: DEFAULT_CATEGORIES.app,
              predicate: () => !!pwaEvent,
              perform: () => {
                if (pwaEvent) {
                  pwaEvent.prompt();
                  pwaEvent.userChoice.then(() => {
                    // event cannot be reused, but we'll hopefully
                    // grab new one as the event should be fired again
                    pwaEvent = null;
                  });
                }
              },
            },
          ]}
        />
        {isVisualDebuggerEnabled() && excalidrawAPI && (
          <DebugCanvas
            appState={excalidrawAPI.getAppState()}
            scale={window.devicePixelRatio}
            ref={debugCanvasRef}
          />
        )}
      </Excalidraw>
    </div>
  );
};

const ExcalidrawApp = () => {
  const isCloudExportWindow =
    window.location.pathname === "/excalidraw-plus-export";
  if (isCloudExportWindow) {
    return <ExcalidrawPlusIframeExport />;
  }

  return (
    <TopErrorBoundary>
      <Provider store={appJotaiStore}>
        <ExcalidrawAPIProvider>
          <ExcalidrawWrapper />
        </ExcalidrawAPIProvider>
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
