import { createContext, useCallback, useContext, useState } from "react";
import { SERVER_URL } from "./socket";

// Accounts are entirely OPTIONAL — every existing feature (joining a
// meeting by name, live sync, running code) works with zero login, exactly
// as before this feature existed. Logging in unlocks three things layered
// on top: in-platform invites, a personal dashboard of saved sessions, and
// Team mode. See README's Design decisions.
//
// The token is kept in localStorage (not cookies) so it survives a page
// refresh, and attached manually via the `authFetch` helper below rather
// than relying on the browser to send it automatically — this is a plain
// SPA talking to a separate API origin, not a same-origin cookie setup.
const AuthContext = createContext(null);

const STORAGE_KEY = "collab-editor-auth"; // { token, username }

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(loadStored);

  const persist = useCallback((value) => {
    setSession(value);
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  async function signup({ username, email, password }) {
    const res = await fetch(`${SERVER_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Signup failed.");
    persist({ token: data.token, username: data.username });
  }

  async function login({ username, password }) {
    const res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed.");
    persist({ token: data.token, username: data.username });
  }

  function logout() {
    persist(null);
  }

  // Convenience wrapper: same as fetch(), but resolves the path against
  // the server's origin and attaches the Authorization header when logged
  // in, so callers don't have to repeat that boilerplate everywhere.
  //
  // Also auto-clears a stale session on a 401: the token in localStorage
  // can outlive its validity on the server (e.g. it expired, or -- as
  // happened during local dev -- the server was restarted without a
  // persistent JWT_SECRET set, which silently invalidates every
  // previously-issued token). Without this, the UI keeps showing the
  // username in the header (that part never re-checks the server) while
  // every actual authenticated request quietly 401s, which looks like a
  // bug rather than what it is: an expired/invalid session.
  const authFetch = useCallback(
    async (path, opts = {}) => {
      const headers = { ...(opts.headers || {}) };
      if (session?.token) headers.Authorization = `Bearer ${session.token}`;
      const res = await fetch(`${SERVER_URL}${path}`, { ...opts, headers });
      if (res.status === 401 && session?.token) {
        persist(null);
      }
      return res;
    },
    [session, persist]
  );

  const value = {
    user: session ? { username: session.username } : null,
    token: session?.token || null,
    signup,
    login,
    logout,
    authFetch,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
