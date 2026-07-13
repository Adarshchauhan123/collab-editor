import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { buildFileTree, sortedEntries } from "./fileUtils";
import "./Dashboard.css";

// The logged-in home base: pending meeting invites, pending team invites,
// the team you host (if any), and any session files a host has shared
// with you. All four come from one aggregate GET /api/dashboard call.
function Dashboard() {
  const { user, authFetch, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Set when you arrived here via the "Dashboard" icon INSIDE a meeting
  // (see Room.jsx's icon rail) — lets us offer a real way back into that
  // exact meeting instead of leaving you stranded with only "back to
  // home," which would mean re-typing the meeting ID and passcode from
  // scratch to rejoin. Not set if you got here any other way (e.g. the
  // top nav, a bookmark), since there's no meeting to return to then.
  const fromRoom = location.state?.fromRoom || null;

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [viewingSession, setViewingSession] = useState(null);
  const [viewingFile, setViewingFile] = useState(null);
  const [busyAction, setBusyAction] = useState("");

  useEffect(() => {
    if (!user) {
      navigate("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/dashboard");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load dashboard.");
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function respondInvite(id, accept) {
    setBusyAction(id);
    try {
      await authFetch(`/api/invites/${id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept }),
      });
      await load();
    } finally {
      setBusyAction("");
    }
  }

  async function respondTeam(hostUsername, accept) {
    setBusyAction(hostUsername);
    try {
      await authFetch(`/api/teams/${hostUsername}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept }),
      });
      await load();
    } finally {
      setBusyAction("");
    }
  }

  async function inviteTeamToNewMeeting() {
    const res = await authFetch("/api/teams/invite-meeting", { method: "POST" });
    const json = await res.json();
    if (res.ok) navigate(`/room/${json.roomId}?pwd=${json.passcode}`);
  }

  function openSession(session) {
    setViewingSession(session);
    const firstFile = Object.keys(session.files || {}).find((p) => !p.endsWith("/"));
    setViewingFile(firstFile || null);
  }

  // Removes one saved session from just YOUR dashboard — other
  // participants' copies of the same shared session are untouched (see
  // sessions.js: each participant got their own separate record). Updates
  // local state directly instead of a full reload so the row disappears
  // immediately rather than waiting on a round trip.
  async function deleteSession(id) {
    if (!window.confirm("Remove this saved session from your dashboard? This can't be undone.")) return;
    setBusyAction(id);
    try {
      const res = await authFetch(`/api/sessions/saved/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Could not delete this session.");
      }
      setData((prev) => ({ ...prev, savedSessions: prev.savedSessions.filter((s) => s.id !== id) }));
      if (viewingSession?.id === id) setViewingSession(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  if (!user) return null;

  const viewingTree = viewingSession ? buildFileTree(viewingSession.files || {}) : null;
  const avatarLetter = user.username?.[0]?.toUpperCase() || "U";

  return (
    <div className="dashboard">
      {/* Sticky topbar */}
      <div className="dashboard-topbar">
        <div className="dashboard-topbar-brand">
          <div className="dashboard-topbar-icon">⌨️</div>
          <span className="dashboard-topbar-title">CollabCode</span>
        </div>
        <div className="dashboard-topbar-right">
          <div className="dashboard-user-chip">
            <div className="dashboard-user-avatar">{avatarLetter}</div>
            <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
              {user.username}
            </span>
          </div>
          <button className="link-button" onClick={logout} style={{ fontSize: "0.85rem" }}>
            Log out
          </button>
        </div>
      </div>

      {/* Back link */}
      <Link to="/" className="dashboard-back">← Back to home</Link>

      {/* Shown only if you got here via the Dashboard icon inside a live
          meeting -- a real way back into that exact room, not just "back
          to home" which would otherwise be the only option and would
          mean re-typing the meeting ID and passcode to rejoin. */}
      {fromRoom && (
        <div className="dashboard-return-banner">
          <span>
            You came here from meeting <code>{fromRoom.roomId}</code>.
          </span>
          <button onClick={() => navigate(`/room/${fromRoom.roomId}?pwd=${fromRoom.passcode}`)}>
            ↩ Return to meeting
          </button>
        </div>
      )}

      {/* Heading */}
      <div className="dashboard-heading">
        <h1>Dashboard</h1>
        <p>Manage your invites, team, and saved sessions.</p>
      </div>

      {loading && <p className="dashboard-empty">Loading…</p>}
      {error && <div className="home-error">{error}</div>}

      {data && (
        <>
          {/* Meeting invites */}
          <section className="dashboard-section">
            <div className="dashboard-section-header">
              <h2>
                <div className="dashboard-section-icon section-icon-cyan">📨</div>
                Meeting invites
              </h2>
              {data.pendingInvites.length > 0 && (
                <span className="badge badge-cyan">{data.pendingInvites.length}</span>
              )}
            </div>
            <div className="dashboard-section-body">
              {data.pendingInvites.length === 0 && (
                <p className="dashboard-empty">No pending invites.</p>
              )}
              {data.pendingInvites.map((inv) => (
                <div className="dashboard-card" key={inv.id}>
                  <span className="dashboard-card-label">
                    <strong>{inv.fromUsername}</strong> invited you to meeting{" "}
                    <code>{inv.roomId}</code>
                  </span>
                  <div className="dashboard-card-actions">
                    <button
                      className="btn-accept"
                      onClick={() => navigate(`/room/${inv.roomId}?pwd=${inv.passcode}`)}
                    >
                      Join
                    </button>
                    <button
                      className="btn-decline"
                      disabled={busyAction === inv.id}
                      onClick={() => respondInvite(inv.id, false)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Team invites */}
          <section className="dashboard-section">
            <div className="dashboard-section-header">
              <h2>
                <div className="dashboard-section-icon section-icon-violet">👥</div>
                Team invites
              </h2>
              {data.teamInvites.length > 0 && (
                <span className="badge badge-violet">{data.teamInvites.length}</span>
              )}
            </div>
            <div className="dashboard-section-body">
              {data.teamInvites.length === 0 && (
                <p className="dashboard-empty">No pending team invites.</p>
              )}
              {data.teamInvites.map((t) => (
                <div className="dashboard-card" key={t.hostUsername}>
                  <span className="dashboard-card-label">
                    <strong>{t.hostUsername}</strong> wants to add you to their team
                  </span>
                  <div className="dashboard-card-actions">
                    <button
                      className="btn-accept"
                      disabled={busyAction === t.hostUsername}
                      onClick={() => respondTeam(t.hostUsername, true)}
                    >
                      Accept
                    </button>
                    <button
                      className="btn-decline"
                      disabled={busyAction === t.hostUsername}
                      onClick={() => respondTeam(t.hostUsername, false)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* My team */}
          <section className="dashboard-section">
            <div className="dashboard-section-header">
              <h2>
                <div className="dashboard-section-icon section-icon-green">🏆</div>
                My team
              </h2>
              {data.myTeam && (
                <span className="badge badge-green">{data.myTeam.members.length} members</span>
              )}
            </div>
            <div className="dashboard-section-body">
              {data.myTeam ? (
                <>
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
                    {data.myTeam.members.length} member{data.myTeam.members.length === 1 ? "" : "s"}:{" "}
                    <strong style={{ color: "var(--text-primary)" }}>
                      {data.myTeam.members.join(", ") || "none yet"}
                    </strong>
                  </p>
                  {data.myTeam.pending.length > 0 && (
                    <p className="dashboard-empty" style={{ marginTop: 8 }}>
                      Awaiting response: {data.myTeam.pending.join(", ")}
                    </p>
                  )}
                  {data.myTeam.members.length > 0 && (
                    <button
                      className="dashboard-team-action"
                      onClick={inviteTeamToNewMeeting}
                    >
                      ✦ Start a meeting &amp; invite whole team
                    </button>
                  )}
                </>
              ) : (
                <p className="dashboard-empty">
                  No team yet — enable "Team Mode" when creating a meeting to start building one.
                </p>
              )}
            </div>
          </section>

          {/* Saved sessions */}
          <section className="dashboard-section">
            <div className="dashboard-section-header">
              <h2>
                <div className="dashboard-section-icon section-icon-amber">💾</div>
                Saved sessions
              </h2>
              {data.savedSessions.length > 0 && (
                <span className="badge badge-cyan">{data.savedSessions.length}</span>
              )}
            </div>
            <div className="dashboard-section-body">
              {data.savedSessions.length === 0 && (
                <p className="dashboard-empty">
                  Nothing saved yet — a host can save a session's files to your dashboard from inside a meeting.
                </p>
              )}
              {data.savedSessions.map((s) => (
                <div className="dashboard-card" key={s.id}>
                  <span className="dashboard-card-label">
                    Meeting <code>{s.roomId}</code> — shared by{" "}
                    <strong>{s.sharedBy}</strong> on {new Date(s.sharedAt).toLocaleString()}
                  </span>
                  <div className="dashboard-card-actions">
                    <button onClick={() => openSession(s)}>View files</button>
                    <button
                      className="btn-decline"
                      disabled={busyAction === s.id}
                      onClick={() => deleteSession(s.id)}
                      title="Remove from your dashboard"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* Session file viewer modal */}
      {viewingSession && (
        <div className="modal-backdrop" onClick={() => setViewingSession(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>
                Session — Meeting <code>{viewingSession.roomId}</code>
              </span>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  className="link-button"
                  disabled={busyAction === viewingSession.id}
                  onClick={() => deleteSession(viewingSession.id)}
                  style={{ color: "var(--tint-rose)" }}
                >
                  🗑 Delete
                </button>
                <button className="link-button" onClick={() => setViewingSession(null)}>
                  ✕ Close
                </button>
              </div>
            </div>
            <div className="modal-body">
              <div className="modal-file-list">
                {sortedEntries(viewingTree).length === 0 && (
                  <p className="dashboard-empty" style={{ padding: "8px 12px" }}>No files.</p>
                )}
                {renderModalTree(viewingTree, 0, viewingFile, setViewingFile)}
              </div>
              <pre className="modal-code">
                {viewingFile
                  ? (viewingSession.files || {})[viewingFile] || "(empty)"
                  : "Select a file to view it."}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Tiny read-only tree renderer for the saved-session viewer.
function renderModalTree(node, depth, selected, onSelect) {
  return sortedEntries(node).map((entry) => {
    if (entry.type === "folder") {
      return (
        <div key={entry.path}>
          <div className="modal-tree-folder" style={{ paddingLeft: 8 + depth * 14 }}>
            📁 {entry.name}
          </div>
          {renderModalTree(entry, depth + 1, selected, onSelect)}
        </div>
      );
    }
    return (
      <div
        key={entry.path}
        className={`modal-tree-file ${entry.path === selected ? "modal-tree-file-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(entry.path)}
      >
        📄 {entry.name}
      </div>
    );
  });
}

export default Dashboard;
