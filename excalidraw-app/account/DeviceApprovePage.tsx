import React, { useState } from "react";

import { approveDevice } from "./authClient";

/**
 * Device-flow approval (/device?code=…). The user is already signed in (the gate
 * guarantees it), so approving links the polling agent (local Claude/Codex) to
 * THIS account.
 */
export const DeviceApprovePage: React.FC<{ email?: string | null }> = ({
  email,
}) => {
  const [code, setCode] = useState(
    new URLSearchParams(window.location.search).get("code") || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const approve = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await approveDevice(code.trim().toUpperCase());
      if (r.ok) {
        setDone(true);
      } else {
        setError(r.data?.detail || "That code is invalid or expired.");
      }
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="eb-page eb-page--center">
      <form className="eb-card eb-rise" onSubmit={approve}>
        <div className="eb-brand">Connect a device</div>
        {done ? (
          <>
            <div className="eb-note eb-note--ok">
              Approved! Your terminal agent is now connected to this account.
              You can close this tab.
            </div>
            <button
              type="button"
              className="eb-btn eb-btn--primary eb-btn--block"
              style={{ marginTop: 18 }}
              onClick={() => window.location.assign("/")}
            >
              Back to Excaliboard
            </button>
          </>
        ) : (
          <>
            <div className="eb-sub">
              {email ? `Signed in as ${email}. ` : ""}A local agent wants to act
              on your boards. Confirm the code it showed you.
            </div>
            <label className="eb-label">Device code</label>
            <input
              className="eb-input"
              style={{
                letterSpacing: "0.22em",
                textAlign: "center",
                fontSize: 19,
                fontWeight: 600,
              }}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX"
              autoFocus
            />
            {error && <div className="eb-note eb-note--error">{error}</div>}
            <button
              type="submit"
              className="eb-btn eb-btn--primary eb-btn--block"
              style={{ marginTop: 22 }}
              disabled={busy || !code.trim()}
            >
              {busy ? "…" : "Approve device"}
            </button>
          </>
        )}
      </form>
    </div>
  );
};
