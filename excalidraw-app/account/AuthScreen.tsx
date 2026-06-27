import React, { useEffect, useState } from "react";

import {
  forgotPassword,
  getAuthConfig,
  googleLoginUrl,
  login,
  resendVerification,
  signup,
} from "./authClient";
import { s } from "./authStyles";

type Mode = "login" | "signup" | "forgot";

/** Full-screen login / signup / forgot card shown when not authenticated. */
export const AuthScreen: React.FC<{
  initialMode?: Mode;
  onSignedIn: () => void;
}> = ({ initialMode = "login", onSignedIn }) => {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [google, setGoogle] = useState(false);

  useEffect(() => {
    getAuthConfig().then((c) => setGoogle(!!c.google));
  }, []);

  const reset = () => {
    setError(null);
    setNotice(null);
    setUnverified(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    setBusy(true);
    try {
      if (mode === "login") {
        const r = await login(email, password);
        if (r.ok) {
          onSignedIn();
        } else if (r.status === 403 && r.data?.unverified) {
          setUnverified(true);
          setError("Please confirm your email before signing in.");
        } else {
          setError(r.data?.detail || "Invalid email or password");
        }
      } else if (mode === "signup") {
        const r = await signup(email, password, name || undefined);
        if (r.ok) {
          setNotice(
            "Account created! Check your email for a confirmation link to finish signing up.",
          );
          setMode("login");
        } else {
          setError(r.data?.detail || "Could not create the account.");
        }
      } else {
        await forgotPassword(email);
        setNotice(
          "If that email has an account, a password-reset link is on its way.",
        );
      }
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  };

  const doResend = async () => {
    reset();
    await resendVerification(email);
    setNotice("Confirmation email re-sent. Check your inbox.");
  };

  return (
    <div style={s.page}>
      <form style={s.card} onSubmit={submit}>
        <div style={s.brand}>Excaliboard</div>
        <div style={s.sub}>Your boards, on every device. Draw with AI.</div>

        {mode !== "forgot" && (
          <div style={s.tabs}>
            <button
              type="button"
              style={{ ...s.tab, ...(mode === "login" ? s.tabActive : {}) }}
              onClick={() => {
                reset();
                setMode("login");
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              style={{ ...s.tab, ...(mode === "signup" ? s.tabActive : {}) }}
              onClick={() => {
                reset();
                setMode("signup");
              }}
            >
              Create account
            </button>
          </div>
        )}

        {mode === "signup" && (
          <>
            <label style={s.label}>Name (optional)</label>
            <input
              style={s.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </>
        )}

        <label style={s.label}>Email</label>
        <input
          style={s.input}
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />

        {mode !== "forgot" && (
          <>
            <label style={s.label}>Password</label>
            <input
              style={s.input}
              type="password"
              required
              minLength={mode === "signup" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
            />
          </>
        )}

        {error && <div style={s.error}>{error}</div>}
        {notice && <div style={s.notice}>{notice}</div>}
        {unverified && (
          <div style={s.linkRow}>
            <button type="button" style={s.link} onClick={doResend}>
              Resend confirmation email
            </button>
          </div>
        )}

        <button type="submit" style={s.primary} disabled={busy}>
          {busy
            ? "…"
            : mode === "login"
            ? "Sign in"
            : mode === "signup"
            ? "Create account"
            : "Send reset link"}
        </button>

        {mode !== "forgot" && google && (
          <>
            <div style={s.divider}>
              <hr style={s.hr} />
              or
              <hr style={s.hr} />
            </div>
            <a href={googleLoginUrl()} style={{ textDecoration: "none" }}>
              <button type="button" style={s.ghost}>
                <GoogleIcon />
                Continue with Google
              </button>
            </a>
          </>
        )}

        <div style={s.linkRow}>
          {mode === "login" && (
            <button
              type="button"
              style={s.link}
              onClick={() => {
                reset();
                setMode("forgot");
              }}
            >
              Forgot your password?
            </button>
          )}
          {mode === "forgot" && (
            <button
              type="button"
              style={s.link}
              onClick={() => {
                reset();
                setMode("login");
              }}
            >
              ← Back to sign in
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
    />
  </svg>
);
