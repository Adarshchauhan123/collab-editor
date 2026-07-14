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

  // Team Chat -- see the section near the bottom of the page. "team" mode
  // broadcasts to every accepted member of one chosen team; "people" mode
  // lets the host hand-pick any subset (one person, a group, or anyone
  // else at all by typing their username -- not limited to your own
  // teams' members). Available even with zero teams -- only the "team"
  // broadcast option needs one.
  const [composeMode, setComposeMode] = useState("team");
  const [composeTeamId, setComposeTeamId] = useState("");
  const [composeRecipients, setComposeRecipients] = useState([]);
  const [composeIndividualInput, setComposeIndividualInput] = useState("");
  const [composeText, setComposeText] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [replyDrafts, setReplyDrafts] = useState({}); // messageId -> draft text
  const [replyOpenFor, setReplyOpenFor] = useState(null); // messageId currently showing its reply box

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

  // Clicking "Join" used to navigate straight into the room WITHOUT ever
  // telling the server this invite was accepted -- so it stayed "pending"
  // forever and kept reappearing here every time the dashboard loaded,
  // even after you'd already joined.
  //
  // Awaited, not fire-and-forget: a locked invite -- one tied to a team
  // invite this person hasn't accepted yet, see teams.js's
  // bulkInviteTeams -- gets REJECTED by the server even if this somehow
  // gets called on one (the Join button below is disabled for those, but
  // this is the real enforcement, not just a UI nicety). Only navigate
  // into the room once the accept actually went through.
  async function joinInvite(inv) {
    if (inv.locked) return;
    try {
      const res = await authFetch(`/api/invites/${inv.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Could not join this meeting.");
        return;
      }
      navigate(`/room/${inv.roomId}?pwd=${inv.passcode}`);
    } catch {
      setError("Could not reach the server.");
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

  // Host removing one person -- works for both an accepted member and a
  // still-pending invite (e.g. a typo'd username), see teams.js.
  async function removeMember(teamId, username) {
    setBusyAction(`remove-${teamId}-${username}`);
    setTeamActionError("");
    try {
      const res = await authFetch(`/api/teams/${teamId}/members/${encodeURIComponent(username)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not remove that person.");
      await load();
    } catch (err) {
      setTeamActionError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  async function deleteTeamAction(team) {
    if (!window.confirm(`Delete "${team.name}" permanently? This removes the team and all its members. This can't be undone.`)) {
      return;
    }
    setBusyAction(`delete-${team.id}`);
    setTeamActionError("");
    try {
      const res = await authFetch(`/api/teams/${team.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not delete team.");
      await load();
    } catch (err) {
      setTeamActionError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  // Self-service: a member leaving a team, distinct from the host
  // removing them via removeMember above.
  async function leaveTeamAction(team) {
    if (!window.confirm(`Leave "${team.name}"? You'd need to be added again to rejoin.`)) return;
    setBusyAction(`leave-${team.id}`);
    setTeamActionError("");
    try {
      const res = await authFetch(`/api/teams/${team.id}/leave`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not leave team.");
      await load();
    } catch (err) {
      setTeamActionError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  // Team Chat -- persistent, host-initiated messaging (see the section
  // near the bottom of the page). toggleRecipient/sendTeamMessage handle
  // composing; toggleMessageLike/sendReply are available to anyone
  // involved in a message (sender or any recipient), not just the host.
  function toggleRecipient(username) {
    setComposeRecipients((prev) => (prev.includes(username) ? prev.filter((u) => u !== username) : [...prev, username]));
  }

  // Not a real <form> submit -- this lives inside the outer Team Chat
  // form (nested <form> elements aren't valid HTML), so it's wired to a
  // plain button click / Enter keypress instead. Lets a host message
  // literally anyone with an account, not just people already in one of
  // their teams.
  function addComposeIndividual() {
    const name = composeIndividualInput.trim();
    if (!name || composeRecipients.includes(name)) return;
    setComposeRecipients((prev) => [...prev, name]);
    setComposeIndividualInput("");
  }

  async function sendTeamMessage(e) {
    e.preventDefault();
    if (!composeText.trim()) return;
    // Only actually "team" mode if there's a team to broadcast to --
    // otherwise the people-picker is what's rendered regardless of what
    // this state variable still says (see effectiveComposeMode below),
    // so sending needs to agree with what's on screen.
    const mode = composeMode === "team" && data.myTeams.length > 0 ? "team" : "people";
    setMessageError("");
    setSendingMessage(true);
    try {
      const body =
        mode === "team"
          ? { recipientType: "team", teamId: composeTeamId, text: composeText.trim() }
          : { recipientType: "people", usernames: composeRecipients, text: composeText.trim() };
      const res = await authFetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not send message.");
      setComposeText("");
      setComposeRecipients([]);
      setComposeTeamId("");
      setComposeIndividualInput("");
      await load();
    } catch (err) {
      setMessageError(err.message);
    } finally {
      setSendingMessage(false);
    }
  }

  async function toggleMessageLike(messageId) {
    try {
      const res = await authFetch(`/api/messages/${messageId}/like`, { method: "POST" });
      if (!res.ok) return;
      await load();
    } catch {
      // Non-critical -- a failed like toggle just leaves the heart as-is.
    }
  }

  async function sendReply(messageId) {
    const text = (replyDrafts[messageId] || "").trim();
    if (!text) return;
    try {
      const res = await authFetch(`/api/messages/${messageId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not send reply.");
      setReplyDrafts((prev) => ({ ...prev, [messageId]: "" }));
      await load();
    } catch (err) {
      setMessageError(err.message);
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

  // Every accepted member across every team this user hosts, deduplicated
  // -- the quick-pick pool "people" mode offers in Team Chat below, on top
  // of being able to type in literally anyone else's username too.
  const allMyMembers = data ? Array.from(new Set(data.myTeams.flatMap((t) => t.members))) : [];

  // "team" broadcast mode only makes sense with at least one team -- if
  // there isn't one, render the people-picker regardless of what the
  // composeMode radio last said (e.g. its default value before any team
  // ever existed). Keeps Team Chat usable from the very first login, not
  // gated behind creating a team first.
  const effectiveComposeMode = data && composeMode === "team" && data.myTeams.length > 0 ? "team" : "people";

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
                    {inv.locked && (
                      <span className="invite-locked-note">
                        {" "}
                        — accept your invite to team <strong>{inv.requiresTeamName}</strong> first to join
                      </span>
                    )}
                  </span>
                  <div className="dashboard-card-actions">
                    <button
                      className="btn-accept"
                      disabled={inv.locked}
                      title={inv.locked ? `Accept your "${inv.requiresTeamName}" team invite first` : undefined}
                      onClick={() => joinInvite(inv)}
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
                              <button
                                className="icon-btn icon-btn-danger"
                                title="Delete team"
                                disabled={busyAction === `delete-${team.id}`}
                                onClick={() => deleteTeamAction(team)}
                              >
                                🗑
                              </button>
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
                            <span className="team-member-chip team-member-chip-removable" key={m}>
                              {m}
                              <button
                                type="button"
                                className="team-chip-remove"
                                title={`Remove ${m} from this team`}
                                disabled={busyAction === `remove-${team.id}-${m}`}
                                onClick={() => removeMember(team.id, m)}
                              >
                                ✕
                              </button>
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
                        <div className="team-member-chips">
                          <span className="team-pending-label">Awaiting response:</span>
                          {team.pending.map((m) => (
                            <span className="team-member-chip team-member-chip-pending team-member-chip-removable" key={m}>
                              {m}
                              <button
                                type="button"
                                className="team-chip-remove"
                                title={`Cancel invite for ${m}`}
                                disabled={busyAction === `remove-${team.id}-${m}`}
                                onClick={() => removeMember(team.id, m)}
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                        </div>
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
                      <button
                        className="icon-btn icon-btn-danger icon-btn-wide"
                        disabled={busyAction === `leave-${team.id}`}
                        onClick={() => leaveTeamAction(team)}
                      >
                        Leave team
                      </button>
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

          {/* Team Chat -- persistent, host-initiated messaging to a whole
              team, a hand-picked group, or one person. Distinct from
              Room.jsx's in-room chat: this lives here on the Dashboard,
              outside any one meeting, and everyone involved (the sender
              AND every recipient) can like or reply. */}
          <section className="dashboard-section">
            <div className="dashboard-section-header">
              <h2>
                <div className="dashboard-section-icon section-icon-rose">💬</div>
                Team Chat
              </h2>
              {data.messages.length > 0 && (
                <span className="badge badge-rose">{data.messages.length}</span>
              )}
            </div>
            <div className="dashboard-section-body">
              <form className="compose-message-form" onSubmit={sendTeamMessage}>
                <div className="compose-mode-toggle">
                  {data.myTeams.length > 0 && (
                    <label className={`compose-mode-option ${effectiveComposeMode === "team" ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="composeMode"
                        checked={effectiveComposeMode === "team"}
                        onChange={() => setComposeMode("team")}
                      />
                      Broadcast to a whole team
                    </label>
                  )}
                  <label className={`compose-mode-option ${effectiveComposeMode === "people" ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="composeMode"
                      checked={effectiveComposeMode === "people"}
                      onChange={() => setComposeMode("people")}
                    />
                    Pick individuals / a group / anyone else
                  </label>
                </div>

                {effectiveComposeMode === "team" ? (
                  <div className="invite-team-pills">
                    {data.myTeams.map((t) => (
                      <button
                        type="button"
                        key={t.id}
                        className={`invite-team-pill ${composeTeamId === t.id ? "selected" : ""}`}
                        onClick={() => setComposeTeamId((prev) => (prev === t.id ? "" : t.id))}
                      >
                        {composeTeamId === t.id && <span className="invite-pill-check">✓</span>}
                        {t.name}
                        <span className="invite-pill-count">{t.members.length}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    {allMyMembers.length > 0 && (
                      <div className="invite-team-pills">
                        {allMyMembers.map((username) => (
                          <button
                            type="button"
                            key={username}
                            className={`invite-team-pill ${composeRecipients.includes(username) ? "selected" : ""}`}
                            onClick={() => toggleRecipient(username)}
                          >
                            {composeRecipients.includes(username) && <span className="invite-pill-check">✓</span>}
                            {username}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="invite-individual-form">
                      <input
                        value={composeIndividualInput}
                        onChange={(e) => setComposeIndividualInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addComposeIndividual();
                          }
                        }}
                        placeholder="Message someone else by username"
                      />
                      <button type="button" onClick={addComposeIndividual} disabled={!composeIndividualInput.trim()}>
                        + Add
                      </button>
                    </div>

                    {composeRecipients.filter((u) => !allMyMembers.includes(u)).length > 0 && (
                      <div className="invite-team-pills" style={{ marginTop: 8 }}>
                        {composeRecipients
                          .filter((u) => !allMyMembers.includes(u))
                          .map((name) => (
                            <button
                              type="button"
                              key={name}
                              className="invite-team-pill selected"
                              onClick={() => toggleRecipient(name)}
                              title="Remove"
                            >
                              {name} ✕
                            </button>
                          ))}
                      </div>
                    )}
                  </>
                )}

                <textarea
                  className="compose-message-text"
                  value={composeText}
                  onChange={(e) => setComposeText(e.target.value)}
                  placeholder="Write a message…"
                  rows={3}
                  maxLength={2000}
                />

                {messageError && (
                  <div className="home-error" style={{ marginBottom: 10 }}>
                    {messageError}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn btn-primary compose-send-btn"
                  disabled={
                    sendingMessage ||
                    !composeText.trim() ||
                    (effectiveComposeMode === "team" ? !composeTeamId : composeRecipients.length === 0)
                  }
                >
                  {sendingMessage ? "Sending…" : "Send"}
                </button>
              </form>

              <div className="message-feed">
                {data.messages.length === 0 && <p className="dashboard-empty">No messages yet.</p>}
                {data.messages.map((m) => (
                  <div className="message-card" key={m.id}>
                    <div className="message-card-header">
                      <strong>{m.fromUsername}</strong>
                      <span className="message-recipients">
                        → {m.teamName ? `team ${m.teamName}` : m.toUsernames.join(", ")}
                      </span>
                      <span className="message-time">{new Date(m.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="message-text">{m.text}</p>
                    <div className="message-card-actions">
                      <button
                        type="button"
                        className={`message-like-btn ${m.likedBy.includes(user.username) ? "liked" : ""}`}
                        onClick={() => toggleMessageLike(m.id)}
                      >
                        ♥ {m.likedBy.length > 0 ? m.likedBy.length : ""}
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setReplyOpenFor(replyOpenFor === m.id ? null : m.id)}
                      >
                        Reply{m.replies.length > 0 ? ` (${m.replies.length})` : ""}
                      </button>
                    </div>

                    {m.replies.length > 0 && (
                      <div className="message-replies">
                        {m.replies.map((r, i) => (
                          <div className="message-reply" key={i}>
                            <strong>{r.fromUsername}:</strong> {r.text}
                          </div>
                        ))}
                      </div>
                    )}

                    {replyOpenFor === m.id && (
                      <form
                        className="message-reply-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          sendReply(m.id);
                        }}
                      >
                        <input
                          value={replyDrafts[m.id] || ""}
                          onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          placeholder="Write a reply…"
                        />
                        <button type="submit">Send</button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
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
