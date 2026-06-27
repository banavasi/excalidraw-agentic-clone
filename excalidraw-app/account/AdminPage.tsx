import React, { useCallback, useEffect, useState } from "react";

import {
  adminDeleteUser,
  adminListUsers,
  adminSetDisabled,
  adminSetRole,
} from "./authClient";
import { s } from "./authStyles";

import type { AdminUser } from "./authClient";

/** Admin-only user management table (/admin). 403s for non-admins. */
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
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.brand}>Not authorized</div>
          <div style={s.sub}>You need an admin account to view this page.</div>
          <button type="button" style={s.primary} onClick={() => window.location.assign("/")}>
            Back to Excaliboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...st.page }}>
      <div style={st.bar}>
        <strong style={{ fontSize: 18 }}>Excaliboard · Admin</strong>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ color: "#6b7280", fontSize: 13 }}>{email}</span>
          <button type="button" style={st.linkBtn} onClick={() => window.location.assign("/")}>
            ← Editor
          </button>
        </div>
      </div>
      <div style={st.wrap}>
        {users === null ? (
          <div style={{ color: "#9ca3af" }}>Loading…</div>
        ) : (
          <table style={st.table}>
            <thead>
              <tr>
                {["Email", "Role", "Method", "Verified", "Boards", "Status", "Actions"].map(
                  (h) => (
                    <th key={h} style={st.th}>
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ opacity: u.disabled ? 0.55 : 1 }}>
                  <td style={st.td}>{u.email || "(no email)"}</td>
                  <td style={st.td}>
                    {u.role === "admin" ? <span style={st.badge}>admin</span> : "user"}
                  </td>
                  <td style={st.td}>{u.auth_method || "—"}</td>
                  <td style={st.td}>{u.email_verified ? "✓" : "—"}</td>
                  <td style={st.td}>{u.board_count}</td>
                  <td style={st.td}>{u.disabled ? "disabled" : "active"}</td>
                  <td style={{ ...st.td, whiteSpace: "nowrap" }}>
                    <Act
                      onClick={async () => {
                        await adminSetDisabled(u.id, !u.disabled);
                        load();
                      }}
                    >
                      {u.disabled ? "Enable" : "Disable"}
                    </Act>
                    <Act
                      onClick={async () => {
                        await adminSetRole(u.id, u.role === "admin" ? "user" : "admin");
                        load();
                      }}
                    >
                      {u.role === "admin" ? "Demote" : "Make admin"}
                    </Act>
                    <Act
                      danger
                      onClick={async () => {
                        if (window.confirm(`Delete ${u.email}? This removes their boards.`)) {
                          await adminDeleteUser(u.id);
                          load();
                        }
                      }}
                    >
                      Delete
                    </Act>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const Act: React.FC<{ onClick: () => void; danger?: boolean; children: React.ReactNode }> = ({
  onClick,
  danger,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{ ...st.act, ...(danger ? { color: "#b42318", borderColor: "#f3c1ba" } : {}) }}
  >
    {children}
  </button>
);

const st: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#f7f7fb", fontFamily: "system-ui, sans-serif" },
  bar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 22px",
    background: "#fff",
    borderBottom: "1px solid #ececf3",
  },
  linkBtn: { background: "none", border: "none", color: "#6965db", cursor: "pointer", fontWeight: 600 },
  wrap: { maxWidth: 1000, margin: "24px auto", padding: "0 16px" },
  table: { width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 10, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
  th: { textAlign: "left", padding: "12px 14px", fontSize: 12, color: "#6b7280", borderBottom: "1px solid #ececf3", textTransform: "uppercase", letterSpacing: "0.04em" },
  td: { padding: "12px 14px", fontSize: 14, borderBottom: "1px solid #f3f4f6" },
  badge: { background: "#ece9ff", color: "#5b53c6", padding: "2px 8px", borderRadius: 6, fontSize: 12, fontWeight: 600 },
  act: { marginRight: 6, padding: "5px 10px", fontSize: 13, borderRadius: 7, border: "1px solid #d7d7e0", background: "#fff", cursor: "pointer", color: "#1b1b1f" },
};
