import React, { useState } from "react";

import { resetPassword } from "./authClient";
import { s } from "./authStyles";

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
    <div style={s.page}>
      <form style={s.card} onSubmit={submit}>
        <div style={s.brand}>Set a new password</div>
        {done ? (
          <>
            <div style={s.notice}>Your password has been updated.</div>
            <button
              type="button"
              style={s.primary}
              onClick={() => window.location.assign("/")}
            >
              Go to sign in
            </button>
          </>
        ) : (
          <>
            <div style={s.sub}>Choose a new password for your account.</div>
            <label style={s.label}>New password</label>
            <input
              style={s.input}
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            {!token && (
              <div style={s.error}>
                This link is missing its token. Request a new one.
              </div>
            )}
            {error && <div style={s.error}>{error}</div>}
            <button type="submit" style={s.primary} disabled={busy || !token}>
              {busy ? "…" : "Update password"}
            </button>
          </>
        )}
      </form>
    </div>
  );
};
