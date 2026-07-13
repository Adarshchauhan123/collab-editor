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

  // Multi-team management state -- see the "My Teams" section below.
  const [newTeamName, setNewTeamName] = useState("");
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [addMemberInputs, setAddMemberInputs] = useState({}); // teamId -> input value
  const [expandedTeams, setExpandedTeams] = useState({}); // teamId -> bool
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [mergeSource, setMergeSource] = useState(null); // the team object the merge was opened from
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeNameChoice, setMergeNameChoice] = useState("source"); // "source" | "target" | "custom"
  const [mergeCustomName, setMergeCustomName] = useState("");
  const [teamActionError, setTeamActionError] = useState("");

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

  async function respondTeam(teamId, accept) {
    setBusyAction(teamId);
    try {
      await authFetch(`/api/teams/${teamId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept }),
      });
      await load();
    } finally {
      setBusyAction("");
    }
  }

  // Kicks off a brand-new meeting with this one team pre-selected in the
  // invite panel on the home page, instead of trying to replicate that
  // whole flow again here — one place owns "create + invite," this just
  // hands off to it.
  function startMeetingWithTeam(team) {
    navigate("/", { state: { preselectTeamId: team.id } });
  }

  async function createTeam(e) {
    e.preventDefault();
    if (!newTeamName.trim()) return;
    setCreatingTeam(true);
    setTeamActionError("");
    try {
      const res = await authFetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTeamName.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not create team.");
      setNewTeamName("");
      await load();
    } catch (err) {
      setTeamActionError(err.message);
    } finally {
      setCreatingTeam(false);
    }
  }

  function startRename(team) {
    setRenamingId(team.id);
    setRenameValue(team.name);
  }

  async function saveRename(teamId) {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    setBusyAction(`rename-${teamId}`);
    setTeamActionError("");
    try {
      const res = await authFetch(`/api/teams/${teamId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not rename team.");
      setRenamingId(null);
      await load();
    } catch (err) {
      setTeamActionError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  async function addMember(teamId) {
    const username = (addMemberInputs[teamId] || "").trim();
    if (!username) return;
    setBusyAction(`add-${teamId}`);
    setTeamActionError("");
    try {
      const res = await authFetch(`/api/teams/${teamId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not add that person.");
      setAddMemberInputs((prev) => ({ ...prev, [teamId]: "" }));
      await load();
    } catch (err) {
      setTeamActionError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  function openMergeModal(team) {
    setTeamActionError("");
    setMergeSource(team);
    setMergeTargetId("");
    setMergeNameChoice("source");
    setMergeCustomName("");
  }

  async function confirmMerge() {
    if (!mergeSource || !mergeTargetId) return;
    const targetTeam = data.myTeams.find((t) => t.id === mergeTargetId);
    if (!targetTeam) return;
    if (
      !window.confirm(
        `Merge "${targetTeam.name}" into "${mergeSource.name}"? Members and pending invites from both combine into one team, and this can't be undone.`
      )
    ) {
      return;
    }
    const name =
      mergeNameChoice === "custom" ? mergeCustomName.trim() : mergeNameChoice === "target" ? targetTeam.name : undefined;
    setBusyAction("merge");
    setTeamActionError("");
    try {
      const res = await authFetch("/api/teams/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId: mergeSource.id, absorbId: mergeTargetId, name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not merge teams.");
      setMergeSource(null);
      await load();
    } catch (err) {
      setTeamActionError(err.message);
    } finally {
      setBusyAction("");
    }
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
                <div className="dashboard-card" key={t.teamId}>
                  <span className="dashboard-card-label">
                    <strong>{t.hostUsername}</strong> invited you to team{" "}
                    <strong>{t.teamName}</strong>
                  </span>
                  <div className="dashboard-card-actions">
                    <button
                      className="btn-accept"
                      disabled={busyAction === t.teamId}
                      onClick={() => respondTeam(t.teamId, true)}
                    >
                      Accept
                    </button>
                    <button
                      className="btn-decline"
                      disabled={busyAction === t.teamId}
                      onClick={() => respondTeam(t.teamId, false)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* My Teams -- a host can own any number of named teams, each
              grown by adding members directly (who still have to accept,
              same consent rule as everything else in this app) or merged
              together permanently when two should become one. */}
          <section className="dashboard-section">
            <div className="dashboard-section-header">
              <h2>
                <div className="dashboard-section-icon section-icon-green">🏆</div>
                My Teams
              </h2>
              {data.myTeams.length > 0 && (
                <span className="badge badge-green">{data.myTeams.length}</span>
              )}
            </div>
            <div className="dashboard-section-body">
              {teamActionError && (
                <div className="home-error" style={{ marginBottom: 14 }}>
                  {teamActionError}
                </div>
              )}

              {data.myTeams.length === 0 && (
                <p className="dashboard-empty">No teams yet — create one below to start building it up.</p>
              )}

              <div className="team-grid">
                {data.myTeams.map((team) => {
                  const expanded = !!expandedTeams[team.id];
                  const visibleMembers = expanded ? team.members : team.members.slice(0, 6);
                  return (
                    <div className="team-card" key={team.id}>
                      <div className="team-card-header">
                        {renamingId === team.id ? (
                          <form
                            className="team-rename-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              saveRename(team.id);
                            }}
                          >
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              maxLength={60}
                            />
                            <button type="submit" title="Save" disabled={busyAction === `rename-${team.id}`}>
                              ✓
                            </button>
                            <button type="button" title="Cancel" onClick={() => setRenamingId(null)}>
                              ✕
                            </button>
                          </form>
                        ) : (
                          <>
                            <span className="team-card-name">{team.name}</span>
                            <div className="team-card-header-actions">
                              <button
                                className="icon-btn"
                                title="Rename team"
                                onClick={() => startRename(team)}
                              >
                                ✎
                              </button>
                              {data.myTeams.length > 1 && (
                                <button
                                  className="icon-btn"
                                  title="Merge with another team"
                                  onClick={() => openMergeModal(team)}
                                >
                                  🔀
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      <div className="team-card-counts">
                        <span className="badge badge-green">{team.members.length} member{team.members.length === 1 ? "" : "s"}</span>
                        {team.pending.length > 0 && (
                          <span className="badge badge-cyan">{team.pending.length} pending</span>
                        )}
                      </div>

                      {team.members.length > 0 ? (
                        <div className="team-member-chips">
                          {visibleMembers.map((m) => (
                            <span className="team-member-chip" key={m}>
                              {m}
                            </span>
                          ))}
                          {!expanded && team.members.length > 6 && (
                            <button
                              className="link-button"
                              style={{ fontSize: "0.75rem" }}
                              onClick={() => setExpandedTeams((prev) => ({ ...prev, [team.id]: true }))}
                            >
                              +{team.members.length - 6} more
                            </button>
                          )}
                        </div>
                      ) : (
                        <p className="dashboard-empty" style={{ marginTop: 4 }}>No members yet.</p>
                      )}

                      {team.pending.length > 0 && (
                        <p className="team-pending-line">Awaiting response: {team.pending.join(", ")}</p>
                      )}

                      <form
                        className="team-add-member-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          addMember(team.id);
                        }}
                      >
                        <input
                          value={addMemberInputs[team.id] || ""}
                          onChange={(e) => setAddMemberInputs((prev) => ({ ...prev, [team.id]: e.target.value }))}
                          placeholder="Add member by username"
                        />
                        <button type="submit" disabled={busyAction === `add-${team.id}`}>
                          + Add
                        </button>
                      </form>

                      {team.members.length > 0 && (
                        <button className="dashboard-team-action" onClick={() => startMeetingWithTeam(team)}>
                          ✦ Start a meeting with this team
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* New team */}
              <form className="team-create-form" onSubmit={createTeam}>
                <input
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="New team name (e.g. Study Group)"
                  maxLength={60}
                />
                <button type="submit" disabled={creatingTeam || !newTeamName.trim()}>
                  {creatingTeam ? "Creating…" : "+ New Team"}
                </button>
              </form>
            </div>
          </section>

          {/* Teams I'm In -- the other side of My Teams above. Accepting a
              team invite made you a member, but until now there was no
              place on YOUR dashboard that showed it -- only the host who
              added you could see the team fill up. Read-only: managing a
              team (rename, add members, merge) is the host's job, not a
              member's. */}
          {data.memberOfTeams.length > 0 && (
            <section className="dashboard-section">
              <div className="dashboard-section-header">
                <h2>
                  <div className="dashboard-section-icon section-icon-cyan">🤝</div>
                  Teams I'm In
                </h2>
                <span className="badge badge-cyan">{data.memberOfTeams.length}</span>
              </div>
              <div className="dashboard-section-body">
                <div className="team-grid">
                  {data.memberOfTeams.map((team) => (
                    <div className="team-card" key={team.id}>
                      <div className="team-card-header">
                        <span className="team-card-name">{team.name}</span>
                      </div>
                      <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", margin: 0 }}>
                        Hosted by <strong style={{ color: "var(--text-primary)" }}>{team.hostUsername}</strong>
                      </p>
                      <div className="team-member-chips">
                        {team.members.map((m) => (
                          <span className={`team-member-chip ${m === user.username ? "team-member-chip-you" : ""}`} key={m}>
                            {m === user.username ? "You" : m}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

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

      {/* Merge-teams modal */}
      {mergeSource && (
        <div className="modal-backdrop" onClick={() => setMergeSource(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(440px, 92vw)" }}>
            <div className="modal-header">
              <span>Merge "{mergeSource.name}" with…</span>
              <button className="link-button" onClick={() => setMergeSource(null)}>
                ✕ Close
              </button>
            </div>
            <div className="modal-body" style={{ flexDirection: "column", padding: 20, gap: 16 }}>
              <div>
                <label className="merge-field-label">Merge into</label>
                <select
                  className="merge-select"
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                >
                  <option value="">Choose a team…</option>
                  {data.myTeams
                    .filter((t) => t.id !== mergeSource.id)
                    .map((t) => (
                      <option value={t.id} key={t.id}>
                        {t.name} ({t.members.length} members)
                      </option>
                    ))}
                </select>
              </div>

              {mergeTargetId && (
                <>
                  <div>
                    <label className="merge-field-label">Name for the combined team</label>
                    <div className="merge-name-options">
                      <label className="merge-name-option">
                        <input
                          type="radio"
                          name="mergeName"
                          checked={mergeNameChoice === "source"}
                          onChange={() => setMergeNameChoice("source")}
                        />
                        Keep "{mergeSource.name}"
                      </label>
                      <label className="merge-name-option">
                        <input
                          type="radio"
                          name="mergeName"
                          checked={mergeNameChoice === "target"}
                          onChange={() => setMergeNameChoice("target")}
                        />
                        Keep "{data.myTeams.find((t) => t.id === mergeTargetId)?.name}"
                      </label>
                      <label className="merge-name-option">
                        <input
                          type="radio"
                          name="mergeName"
                          checked={mergeNameChoice === "custom"}
                          onChange={() => setMergeNameChoice("custom")}
                        />
                        New name:
                        <input
                          className="merge-custom-name-input"
                          value={mergeCustomName}
                          onChange={(e) => {
                            setMergeCustomName(e.target.value);
                            setMergeNameChoice("custom");
                          }}
                          placeholder="Combined team name"
                          maxLength={60}
                        />
                      </label>
                    </div>
                  </div>

                  <button
                    className="dashboard-team-action"
                    disabled={busyAction === "merge" || (mergeNameChoice === "custom" && !mergeCustomName.trim())}
                    onClick={confirmMerge}
                  >
                    🔀 Merge permanently
                  </button>
                  <p className="dashboard-empty" style={{ margin: 0 }}>
                    Members and pending invites from both teams combine into one. This can't be undone.
                  </p>
                </>
              )}
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
