import React, { useCallback, useEffect, useState } from "react";

import {
  adminDeleteUser,
  adminListUsers,
  adminSetDisabled,
  adminSetRole,
} from "./authClient";

import type { AdminUser } from "./authClient";

/** Admin-only user management table (/manage). 403s for non-admins. */
export const AdminPage: React.FC<{ email?: string | null }> = ({ email }) => {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    const r = await adminListUsers();
    if (r.status === 403) {
      setDenied(true);
    } else if (r.ok) {
      setUsers(r.data as AdminUser[]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (denied) {
    return (
      <div className="eb-page eb-page--center">
        <div className="eb-card eb-rise">
          <div className="eb-brand">Not authorized</div>
          <div className="eb-sub">
            You need an admin account to view this page.
          </div>
          <button
            type="button"
            className="eb-btn eb-btn--primary eb-btn--block"
            style={{ marginTop: 18 }}
            onClick={() => window.location.assign("/boards")}
          >
            Back to Excaliboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="eb-page">
      <header className="eb-bar">
        <div className="eb-brand" style={{ fontSize: 17 }}>
          Excaliboard <span style={{ color: "var(--eb-muted)" }}>· Admin</span>
        </div>
        <div className="eb-bar__right">
          <span className="eb-bar__email">{email}</span>
          <button
            type="button"
            className="eb-link"
            onClick={() => window.location.assign("/boards")}
          >
            ← Boards
          </button>
        </div>
      </header>

      <div className="eb-wrap">
        <div className="eb-head">
          <h1 className="eb-title">Users</h1>
        </div>

        {users === null ? (
          <div className="eb-muted">Loading…</div>
        ) : (
          <div className="eb-table-wrap eb-rise">
            <table className="eb-table">
              <thead>
                <tr>
                  {[
                    "Email",
                    "Role",
                    "Method",
                    "Verified",
                    "Boards",
                    "Status",
                    "",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className={u.disabled ? "eb-row--disabled" : ""}
                  >
                    <td>{u.email || "(no email)"}</td>
                    <td>
                      {u.role === "admin" ? (
                        <span className="eb-badge">admin</span>
                      ) : (
                        "user"
                      )}
                    </td>
                    <td>{u.auth_method || "—"}</td>
                    <td>{u.email_verified ? "✓" : "—"}</td>
                    <td>{u.board_count}</td>
                    <td>{u.disabled ? "disabled" : "active"}</td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      <button
                        type="button"
                        className="eb-tag"
                        onClick={async () => {
                          await adminSetDisabled(u.id, !u.disabled);
                          load();
                        }}
                      >
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                      <button
                        type="button"
                        className="eb-tag"
                        onClick={async () => {
                          await adminSetRole(
                            u.id,
                            u.role === "admin" ? "user" : "admin",
                          );
                          load();
                        }}
                      >
                        {u.role === "admin" ? "Demote" : "Make admin"}
                      </button>
                      <button
                        type="button"
                        className="eb-tag eb-tag--danger"
                        onClick={async () => {
                          if (
                            window.confirm(
                              `Delete ${u.email}? This removes their boards.`,
                            )
                          ) {
                            await adminDeleteUser(u.id);
                            load();
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
