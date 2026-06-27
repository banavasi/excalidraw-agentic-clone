/**
 * Auth API client (Phase 7). Same-origin by default — in prod nginx routes
 * /auth, /sync, /oauth, /admin to the API; in dev Vite proxies them (see
 * vite.config.mts). `credentials: "include"` so the session cookie rides along.
 */

const API_BASE = ""; // same-origin

export interface Me {
  authenticated: boolean;
  email?: string | null;
  role?: string;
  display_name?: string | null;
}

interface Result {
  ok: boolean;
  status: number;
  data: any;
}

async function request(path: string, init?: RequestInit): Promise<Result> {
  const res = await fetch(API_BASE + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty / non-JSON */
  }
  return { ok: res.ok, status: res.status, data };
}

const post = (path: string, body: unknown) =>
  request(path, { method: "POST", body: JSON.stringify(body) });

export const getMe = async (): Promise<Me> => {
  try {
    return (await request("/auth/me")).data as Me;
  } catch {
    return { authenticated: false };
  }
};

export const getAuthConfig = async (): Promise<{ google: boolean }> => {
  try {
    return (await request("/auth/config")).data as { google: boolean };
  } catch {
    return { google: false };
  }
};

export const login = (email: string, password: string) =>
  post("/auth/login", { email, password });

export const signup = (email: string, password: string, name?: string) =>
  post("/auth/signup", { email, password, name });

export const resendVerification = (email: string) =>
  post("/auth/resend", { email });

export const forgotPassword = (email: string) =>
  post("/auth/forgot", { email });

export const resetPassword = (token: string, password: string) =>
  post("/auth/reset", { token, password });

export const logout = () => post("/auth/logout", {});

export const approveDevice = (user_code: string) =>
  post("/oauth/device/approve", { user_code });

// --- admin ---
export interface AdminUser {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  auth_method: string | null;
  email_verified: boolean;
  disabled: boolean;
  board_count: number;
}

export const adminListUsers = () => request("/admin/users");
export const adminSetDisabled = (id: string, disabled: boolean) =>
  post(`/admin/users/${id}/${disabled ? "disable" : "enable"}`, {});
export const adminSetRole = (id: string, role: string) =>
  post(`/admin/users/${id}/role`, { role });
export const adminDeleteUser = (id: string) =>
  request(`/admin/users/${id}`, { method: "DELETE" });

export const googleLoginUrl = () => "/auth/google/login";
