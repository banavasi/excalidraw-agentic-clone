import React, { useEffect, useState } from "react";

import { getSyncConfig, isSyncConfigured } from "../data/excaliboardSync";

/**
 * Top-right Cloud-sync button (replaces the upstream Excalidraw+ promo). Shows a
 * status dot — green: on · amber: on but offline · gray: off — and opens the
 * Cloud-sync dialog on click. Status is read from the saved config at render
 * (the app re-renders when the dialog saves) plus a live online/offline listener.
 */
export const CloudSyncButton: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const [online, setOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const configured = isSyncConfigured(getSyncConfig());
  const status = !configured ? "off" : online ? "on" : "offline";
  const color =
    status === "on" ? "#2f9e44" : status === "offline" ? "#f08c00" : "#9aa0a6";
  const title =
    status === "on"
      ? "Cloud sync is on"
      : status === "offline"
      ? "Cloud sync is on — offline; changes sync when you reconnect"
      : "Cloud sync is off — click to set up";

  return (
    <button
      type="button"
      className="excaliboard-sync-banner"
      onClick={onOpen}
      title={title}
    >
      <span
        className="excaliboard-sync-dot"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4.5 4.5 0 0 0 7 19h10.5Z" />
      </svg>
      Cloud sync
    </button>
  );
};
