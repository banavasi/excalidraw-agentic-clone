import React, { useState } from "react";

import { resetPassword } from "./authClient";

/** Public page reached from the password-reset email link (/reset?token=…). */
export const ResetPasswordPage: React.FC = () => {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await resetPassword(token, password);
      if (r.ok) {
        setDone(true);
      } else {
        setError(r.data?.detail || "This reset link is invalid or expired.");
      }
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="eb-page eb-page--center">
      <form className="eb-card eb-rise" onSubmit={submit}>
        <div className="eb-brand">Set a new password</div>
        {done ? (
          <>
            <div className="eb-note eb-note--ok">
              Your password has been updated.
            </div>
            <button
              type="button"
              className="eb-btn eb-btn--primary eb-btn--block"
              style={{ marginTop: 18 }}
              onClick={() => window.location.assign("/")}
            >
              Go to sign in
            </button>
          </>
        ) : (
          <>
            <div className="eb-sub">
              Choose a new password for your account.
            </div>
            <label className="eb-label">New password</label>
            <input
              className="eb-input"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            {!token && (
              <div className="eb-note eb-note--error">
                This link is missing its token. Request a new one.
              </div>
            )}
            {error && <div className="eb-note eb-note--error">{error}</div>}
            <button
              type="submit"
              className="eb-btn eb-btn--primary eb-btn--block"
              style={{ marginTop: 22 }}
              disabled={busy || !token}
            >
              {busy ? "…" : "Update password"}
            </button>
          </>
        )}
      </form>
    </div>
  );
};
