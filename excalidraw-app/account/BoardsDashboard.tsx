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
    <div style={s.page}>
      <header style={s.bar}>
        <div style={s.brand}>Excaliboard</div>
        <div style={s.barRight}>
          {email && <span style={s.email}>{email}</span>}
          <button
            type="button"
            style={s.signout}
            onClick={async () => {
              await logout();
              window.location.assign("/");
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div style={s.wrap}>
        <div style={s.head}>
          <h1 style={s.title}>Your boards</h1>
          <button type="button" style={s.newBtn} onClick={onNew}>
            + New board
          </button>
        </div>

        {syncing && boards.length === 0 ? (
          <div style={s.muted}>Loading your boards…</div>
        ) : boards.length === 0 ? (
          <div style={s.empty}>
            <div style={{ fontSize: 15, marginBottom: 14 }}>No boards yet.</div>
            <button type="button" style={s.newBtn} onClick={onNew}>
              Create your first board
            </button>
          </div>
        ) : (
          <div style={s.grid}>
            {boards.map((b) => (
              <div key={b.id} style={s.card}>
                <button
                  type="button"
                  style={s.thumbBtn}
                  onClick={() => openBoard(b.id)}
                  title={`Open ${b.name}`}
                >
                  {thumbs[b.id] ? (
                    <img src={thumbs[b.id]} alt="" style={s.thumbImg} />
                  ) : (
                    <div style={s.thumbPlaceholder}>
                      {b.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                </button>
                <div style={s.cardFoot}>
                  <div style={s.cardMeta}>
                    <div style={s.cardName} title={b.name}>
                      {b.name}
                    </div>
                    <div style={s.cardTime}>{timeAgo(b.updatedAt)}</div>
                  </div>
                  <div style={s.cardActions}>
                    <button
                      type="button"
                      style={s.iconBtn}
                      onClick={() => onRename(b)}
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      style={{ ...s.iconBtn, color: "#b42318" }}
                      onClick={() => onDelete(b)}
                      title="Delete"
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

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f7f7fb",
    fontFamily: "system-ui, sans-serif",
    color: "#1b1b1f",
  },
  bar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 22px",
    background: "#fff",
    borderBottom: "1px solid #ececf3",
  },
  brand: { fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" },
  barRight: { display: "flex", alignItems: "center", gap: 14 },
  email: { fontSize: 13, color: "#6b7280" },
  signout: {
    background: "none",
    border: "none",
    color: "#b42318",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  wrap: { maxWidth: 1080, margin: "28px auto", padding: "0 20px" },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 22,
  },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  newBtn: {
    background: "#6965db",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  muted: { color: "#9ca3af", fontSize: 14 },
  empty: { textAlign: "center", padding: "80px 0", color: "#6b7280" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 18,
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    border: "1px solid #ececf3",
    overflow: "hidden",
    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
  },
  thumbBtn: {
    display: "block",
    width: "100%",
    height: 140,
    padding: 0,
    border: "none",
    cursor: "pointer",
    background: "#f3f4f6",
  },
  thumbImg: { width: "100%", height: "100%", objectFit: "cover" },
  thumbPlaceholder: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 40,
    fontWeight: 700,
    color: "#c4c2e8",
    background: "linear-gradient(135deg,#ece9ff,#f5f3ff)",
  },
  cardFoot: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px",
    gap: 8,
  },
  cardMeta: { minWidth: 0 },
  cardName: {
    fontSize: 14,
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  cardTime: { fontSize: 12, color: "#9ca3af", marginTop: 2 },
  cardActions: { display: "flex", gap: 2, flexShrink: 0 },
  iconBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    padding: 4,
    borderRadius: 6,
    color: "#6b7280",
  },
};
