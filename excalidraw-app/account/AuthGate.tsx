import React, { useEffect, useState } from "react";

import ExcalidrawApp from "../App";

import { AdminPage } from "./AdminPage";
import { getMe } from "./authClient";
import { AuthScreen } from "./AuthScreen";
import {
  getBoardOwner,
  resetLocalBoardState,
  setBoardOwner,
} from "./boardReset";
import { DeviceApprovePage } from "./DeviceApprovePage";
import { ResetPasswordPage } from "./ResetPasswordPage";
import { s } from "./authStyles";

import type { Me } from "./authClient";

/**
 * Auth gate (the app has no router). Path-based:
 *   /reset            -> public reset page (no auth)
 *   not authenticated -> AuthScreen (login/signup)
 *   /device           -> device-approval (authed)
 *   else              -> the Excalidraw editor
 */
export const AuthGate: React.FC = () => {
  const [me, setMe] = useState<Me | null>(null);
  // The editor may only mount once the local board space belongs to THIS account
  // (a fresh account triggers a complete wipe first — see boardReset).
  const [boardsReady, setBoardsReady] = useState(false);
  const path = window.location.pathname;

  useEffect(() => {
    getMe().then(setMe);
  }, []);

  useEffect(() => {
    if (!me?.authenticated) {
      return;
    }
    const email = me.email || "";
    if (getBoardOwner() === email) {
      setBoardsReady(true);
      return;
    }
    // Different account (or first sign-in on this browser): wipe the previous
    // owner's boards BEFORE the editor boots, then claim the space.
    resetLocalBoardState().then(() => {
      setBoardOwner(email);
      setBoardsReady(true);
    });
  }, [me]);

  // Public, no-auth-needed route.
  if (path === "/reset") {
    return <ResetPasswordPage />;
  }

  if (me === null) {
    return (
      <div style={{ ...s.page, background: "#f7f7fb" }}>
        <div style={{ color: "#9ca3af", fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  if (!me.authenticated) {
    return (
      <AuthScreen
        initialMode={path === "/signup" ? "signup" : "login"}
        onSignedIn={() => window.location.assign("/")}
      />
    );
  }

  // Authenticated but parked on an auth URL -> send to the editor.
  if (path === "/login" || path === "/signup") {
    window.location.assign("/");
    return null;
  }

  if (path === "/device") {
    return <DeviceApprovePage email={me.email} />;
  }

  // The admin PAGE lives at /manage (the /admin prefix is the admin API namespace).
  if (path === "/manage") {
    return <AdminPage email={me.email} />;
  }

  // Editor: wait for the account-switch board reset to finish so App.tsx's
  // synchronous workboards bootstrap never runs against a stale board space.
  if (!boardsReady) {
    return (
      <div style={{ ...s.page, background: "#f7f7fb" }}>
        <div style={{ color: "#9ca3af", fontSize: 14 }}>Loading your boards…</div>
      </div>
    );
  }

  return <ExcalidrawApp />;
};
