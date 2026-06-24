import React, { useEffect, useState } from "react";

import { getSyncConfig, setSyncConfig } from "../data/excaliboardSync";

import type { SyncConfig } from "../data/excaliboardSync";

/**
 * Cloud-sync settings, Phase 6: zero secrets. Identity comes from Cloudflare Access
 * (the app sits behind its email gate), and E2E was dropped (the server is your own
 * trusted box) — so there's nothing to paste. Just an on/off toggle, plus a read-out
 * of who you're signed in as (GET /sync/whoami, same-origin → rides the CF cookie).
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
    // Same-origin (relative): rides the Cloudflare Access cookie, no CORS.
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
    const config: SyncConfig = { enabled };
    setSyncConfig(config);
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
              <strong>{identity}</strong>
              <span style={styles.muted}>verified by Cloudflare</span>
            </>
          ) : (
            <span style={styles.muted}>
              Not signed in via Cloudflare Access (sync auth will be unavailable
              until this app is behind the Access gate).
            </span>
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
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  panel: {
    background: "var(--island-bg-color, #fff)",
    color: "var(--text-primary-color, #1b1b1f)",
    width: "min(440px, 92vw)",
    borderRadius: 8,
    padding: 24,
    boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
    fontSize: 14,
  },
  title: { margin: "0 0 8px" },
  hint: { margin: "0 0 16px", fontSize: 13, opacity: 0.8, lineHeight: 1.5 },
  identity: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "12px 14px",
    marginBottom: 16,
    borderRadius: 6,
    background: "var(--input-bg-color, #f5f5f7)",
    border: "1px solid var(--default-border-color, #ced4da)",
    fontSize: 14,
  },
  muted: { fontSize: 12, opacity: 0.65 },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 20,
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8 },
  button: {
    padding: "8px 16px",
    borderRadius: 6,
    border: "1px solid var(--default-border-color, #ced4da)",
    background: "var(--island-bg-color, #fff)",
    color: "inherit",
    cursor: "pointer",
  },
  primary: {
    background: "var(--color-primary, #6965db)",
    borderColor: "var(--color-primary, #6965db)",
    color: "#fff",
  },
};
