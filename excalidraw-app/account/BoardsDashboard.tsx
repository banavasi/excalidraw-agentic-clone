import React, { useCallback, useEffect, useState } from "react";

import { fromBase64, RestSyncBackend } from "../data/excaliboardSync";
import {
  createWorkboard,
  deleteWorkboard,
  loadWorkboardIndex,
  loadWorkboardThumbnail,
  renameWorkboard,
  setActiveWorkboardId,
  upsertWorkboardIndexEntry,
} from "../workboards/data";

import { logout } from "./authClient";

import type { Workboard } from "../workboards/data";

const byRecent = (b: Workboard[]) =>
  [...b].sort((a, c) => c.updatedAt - a.updatedAt);

const openBoard = (id: string) => {
  setActiveWorkboardId(id);
  window.location.assign("/"); // the editor boots on the active board
};

const timeAgo = (ms: number): string => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) {
    return "just now";
  }
  const m = s / 60;
  if (m < 60) {
    return `${Math.floor(m)}m ago`;
  }
  const h = m / 60;
  if (h < 24) {
    return `${Math.floor(h)}h ago`;
  }
  const d = h / 24;
  if (d < 7) {
    return `${Math.floor(d)}d ago`;
  }
  return new Date(ms).toLocaleDateString();
};

/** Dashboard home: every board for this account, with create / open / manage. */
export const BoardsDashboard: React.FC<{ email?: string | null }> = ({
  email,
}) => {
  const [boards, setBoards] = useState<Workboard[]>(() =>
    byRecent(loadWorkboardIndex()),
  );
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(true);

  const refresh = useCallback(
    () => setBoards(byRecent(loadWorkboardIndex())),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The editor's sync engine isn't mounted here, so pull the server index
      // ourselves — boards then show even on a fresh browser / after a reset.
      try {
        const rows = await new RestSyncBackend({ serverUrl: "" }).getIndex(
          null,
        );
        for (const row of rows) {
          if (row.deleted) {
            continue;
          }
          let name = "Untitled board";
          if (row.nameCt) {
            try {
              name = new TextDecoder().decode(fromBase64(row.nameCt));
            } catch {
              /* keep default */
            }
          }
          upsertWorkboardIndexEntry(row.boardId, name);
        }
      } catch {
        /* offline / unauth — fall back to the local index */
      }
      if (cancelled) {
        return;
      }
      const list = byRecent(loadWorkboardIndex());
      setBoards(list);
      setSyncing(false);
      const entries = await Promise.all(
        list.map(
          async (b) => [b.id, await loadWorkboardThumbnail(b.id)] as const,
        ),
      );
      if (!cancelled) {
        setThumbs(
          Object.fromEntries(
            entries.filter(([, t]) => !!t) as [string, string][],
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onNew = () => openBoard(createWorkboard().id);

  const onRename = (b: Workboard) => {
    const name = window.prompt("Rename board", b.name);
    if (name && name.trim()) {
      renameWorkboard(b.id, name.trim());
      refresh();
    }
  };

  const onDelete = async (b: Workboard) => {
    if (!window.confirm(`Delete "${b.name}"? This can't be undone.`)) {
      return;
    }
    try {
      await new RestSyncBackend({ serverUrl: "" }).deleteBoard(b.id); // server tombstone
    } catch {
      /* still remove locally */
    }
    await deleteWorkboard(b.id);
    refresh();
  };

  return (
    <div className="eb-page">
      <header className="eb-bar">
        <div className="eb-brand" style={{ fontSize: 17 }}>
          Excaliboard
        </div>
        <div className="eb-bar__right">
          {email && <span className="eb-bar__email">{email}</span>}
          <button
            type="button"
            className="eb-link"
            style={{ color: "var(--eb-danger)" }}
            onClick={async () => {
              await logout();
              window.location.assign("/");
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="eb-wrap">
        <div className="eb-head">
          <h1 className="eb-title">Your boards</h1>
          <button
            type="button"
            className="eb-btn eb-btn--primary"
            onClick={onNew}
          >
            + New board
          </button>
        </div>

        {syncing && boards.length === 0 ? (
          <div className="eb-muted">Loading your boards…</div>
        ) : boards.length === 0 ? (
          <div className="eb-empty">
            <div style={{ fontSize: 15, marginBottom: 16 }}>No boards yet.</div>
            <button
              type="button"
              className="eb-btn eb-btn--primary"
              onClick={onNew}
            >
              Create your first board
            </button>
          </div>
        ) : (
          <div className="eb-grid eb-stagger">
            {boards.map((b) => (
              <div key={b.id} className="eb-board">
                <button
                  type="button"
                  className="eb-board__thumb"
                  onClick={() => openBoard(b.id)}
                  title={`Open ${b.name}`}
                >
                  {thumbs[b.id] ? (
                    <img src={thumbs[b.id]} alt="" />
                  ) : (
                    <div className="eb-board__ph">
                      {b.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                </button>
                <div className="eb-board__foot">
                  <div style={{ minWidth: 0 }}>
                    <div className="eb-board__name" title={b.name}>
                      {b.name}
                    </div>
                    <div className="eb-board__time">{timeAgo(b.updatedAt)}</div>
                  </div>
                  <div className="eb-board__actions">
                    <button
                      type="button"
                      className="eb-icon-btn"
                      onClick={() => onRename(b)}
                      title="Rename"
                      aria-label={`Rename ${b.name}`}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="eb-icon-btn eb-icon-btn--danger"
                      onClick={() => onDelete(b)}
                      title="Delete"
                      aria-label={`Delete ${b.name}`}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
