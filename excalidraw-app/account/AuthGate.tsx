import React, { useEffect, useState } from "react";

import ExcalidrawApp from "../App";

import { AdminPage } from "./AdminPage";
import { getMe } from "./authClient";
import { AuthScreen } from "./AuthScreen";
import { BoardsDashboard } from "./BoardsDashboard";
import {
  getBoardOwner,
  resetLocalBoardState,
  setBoardOwner,
} from "./boardReset";
import { DeviceApprovePage } from "./DeviceApprovePage";
import { ResetPasswordPage } from "./ResetPasswordPage";

import type { Me } from "./authClient";

const Splash: React.FC<{ label: string }> = ({ label }) => (
  <div className="eb-page eb-page--center">
    <div className="eb-muted">{label}</div>
  </div>
);

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
    return <Splash label="Loading…" />;
  }

  if (!me.authenticated) {
    return (
      <AuthScreen
        initialMode={path === "/signup" ? "signup" : "login"}
        onSignedIn={() => window.location.assign("/boards")}
      />
    );
  }

  // Authenticated but parked on an auth URL -> send to the boards dashboard.
  if (path === "/login" || path === "/signup") {
    window.location.assign("/boards");
    return null;
  }

  if (path === "/device") {
    return <DeviceApprovePage email={me.email} />;
  }

  // The admin PAGE lives at /manage (the /admin prefix is the admin API namespace).
  if (path === "/manage") {
    return <AdminPage email={me.email} />;
  }

  // Board-backed pages (dashboard + editor) wait for the account-switch reset so
  // they never read a stale board space.
  if (!boardsReady) {
    return <Splash label="Loading your boards…" />;
  }

  if (path === "/boards") {
    return <BoardsDashboard email={me.email} />;
  }

  return <ExcalidrawApp />;
};
