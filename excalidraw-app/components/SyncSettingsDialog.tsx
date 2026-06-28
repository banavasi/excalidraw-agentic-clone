import React, { useEffect, useState } from "react";

import { logout } from "../account/authClient";
import { getSyncConfig, setSyncConfig } from "../data/excaliboardSync";

import type { SyncConfig } from "../data/excaliboardSync";

/**
 * Cloud-sync settings (Phase 7): identity is your in-app account (the session
 * cookie), E2E is dropped, so there's nothing to paste — just an on/off toggle,
 * a read-out of who you're signed in as (GET /sync/whoami), and a sign-out.
 *
 * Rendered INSIDE the editor, so it stays theme-aware (Excalidraw CSS vars) while
 * borrowing the shared radii/shadow/motion tokens from account.scss.
 */
export const SyncSettingsDialog: React.FC<{
  onClose: () => void;
  onSaved: () => void;
}> = ({ onClose, onSaved }) => {
  const existing = getSyncConfig();
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  // null = checking; "" = reachable but no identity (dev/no-Access); else the email.
  const [identity, setIdentity] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/sync/whoami")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled) {
          setIdentity(j?.email ?? "");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIdentity("");
        }
      });
    return () => {
      cancelled = true;
    };
    // existing is derived from localStorage at mount; intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
    setSyncConfig({ enabled } as SyncConfig);
    onSaved();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cloud sync settings"
      style={styles.overlay}
      onClick={onClose}
    >
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>Cloud sync</h2>
        <p style={styles.hint}>
          Your boards sync across every device you sign in on. Nothing to paste
          — you're identified by your login.
        </p>

        <div style={styles.identity}>
          {identity === null ? (
            <span style={styles.muted}>Checking sign-in…</span>
          ) : identity ? (
            <>
              <span style={styles.muted}>Signed in as</span>
              <strong style={{ fontSize: 14 }}>{identity}</strong>
            </>
          ) : (
            <span style={styles.muted}>Signed in.</span>
          )}
        </div>

        <label style={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable sync
        </label>

        <div style={styles.actions}>
          <button
            type="button"
            onClick={async () => {
              // Just drop the session + reload. Board state is NOT wiped here —
              // re-login as the same account keeps your boards; a different
              // account triggers a clean reset in AuthGate before the editor boots.
              await logout();
              window.location.assign("/");
            }}
            style={{
              ...styles.button,
              marginRight: "auto",
              color: "var(--eb-danger, #c5362c)",
            }}
          >
            Sign out
          </button>
          <button type="button" onClick={onClose} style={styles.button}>
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            style={{ ...styles.button, ...styles.primary }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(20,18,45,0.42)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2000,
    animation: "eb-fade 0.18s var(--eb-ease, ease)",
  },
  panel: {
    background: "var(--island-bg-color, #fff)",
    color: "var(--text-primary-color, #1a1a22)",
    width: "min(440px, 92vw)",
    borderRadius: "var(--eb-r-lg, 16px)",
    padding: 24,
    boxShadow: "var(--eb-shadow-lg, 0 20px 54px rgba(26,23,80,0.16))",
    fontSize: 14,
    animation: "eb-pop 0.22s var(--eb-ease, ease)",
  },
  title: {
    margin: "0 0 8px",
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: "-0.01em",
  },
  hint: { margin: "0 0 16px", fontSize: 13, opacity: 0.78, lineHeight: 1.5 },
  identity: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    padding: "12px 14px",
    marginBottom: 18,
    borderRadius: "var(--eb-r-sm, 8px)",
    background: "var(--input-bg-color, #f3f4f8)",
    border: "1px solid var(--default-border-color, #e7e7f0)",
  },
  muted: { fontSize: 12, opacity: 0.7 },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    marginBottom: 22,
    cursor: "pointer",
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8 },
  button: {
    padding: "9px 16px",
    borderRadius: "var(--eb-r-md, 12px)",
    border: "1px solid var(--default-border-color, #d6d6e3)",
    background: "var(--island-bg-color, #fff)",
    color: "inherit",
    fontWeight: 600,
    cursor: "pointer",
  },
  primary: {
    background: "var(--color-primary, #6965db)",
    borderColor: "transparent",
    color: "#fff",
  },
};
