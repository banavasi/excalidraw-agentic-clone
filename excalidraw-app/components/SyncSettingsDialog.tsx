import React, { useState } from "react";

import {
  generateSyncKey,
  getSyncConfig,
  setSyncConfig,
} from "../data/excaliboardSync";

import type { SyncConfig } from "../data/excaliboardSync";

/**
 * Minimal cloud-sync settings: server URL, access token, E2E encryption key, and
 * an enable toggle. The key is client-only (the server never sees it) and must be
 * identical on every device — hence the explicit "copy/paste the same key" hint.
 */
export const SyncSettingsDialog: React.FC<{
  onClose: () => void;
  onSaved: () => void;
}> = ({ onClose, onSaved }) => {
  const existing = getSyncConfig();
  const [serverUrl, setServerUrl] = useState(
    existing?.serverUrl ?? import.meta.env.VITE_APP_EXCALIBOARD_URL ?? "",
  );
  const [bearer, setBearer] = useState(existing?.bearer ?? "");
  const [encryptionKey, setEncryptionKey] = useState(
    existing?.encryptionKey ?? "",
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);

  const save = () => {
    const config: SyncConfig = {
      serverUrl: serverUrl.trim(),
      bearer: bearer.trim(),
      encryptionKey: encryptionKey.trim(),
      enabled,
    };
    setSyncConfig(config);
    onSaved();
    onClose();
  };

  const genKey = async () => {
    setEncryptionKey(await generateSyncKey());
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
          Sync your workboards across devices. The server stores only encrypted
          data — your encryption key never leaves this browser. Use the{" "}
          <strong>same key on every device</strong>; without it, your boards
          can't be decrypted.
        </p>

        <label style={styles.label}>
          Server URL
          <input
            style={styles.input}
            value={serverUrl}
            placeholder="https://sync.example.com"
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </label>

        <label style={styles.label}>
          Access token
          <input
            style={styles.input}
            type="password"
            value={bearer}
            onChange={(e) => setBearer(e.target.value)}
          />
        </label>

        <label style={styles.label}>
          Encryption key (JWK)
          <input
            style={styles.input}
            value={encryptionKey}
            placeholder="paste your key, or generate one"
            onChange={(e) => setEncryptionKey(e.target.value)}
          />
        </label>
        <button type="button" style={styles.linkButton} onClick={genKey}>
          Generate a new key
        </button>

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
  label: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 },
  input: {
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--default-border-color, #ced4da)",
    background: "var(--input-bg-color, #fff)",
    color: "inherit",
    fontSize: 14,
  },
  linkButton: {
    background: "none",
    border: "none",
    color: "var(--color-primary, #6965db)",
    cursor: "pointer",
    padding: 0,
    marginBottom: 16,
    fontSize: 13,
  },
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
