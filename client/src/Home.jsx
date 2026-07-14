import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { SERVER_URL } from "./socket";
import { useAuth } from "./AuthContext";

// Everything about a not-yet-created meeting's setup (access mode,
// auto-team roster, who's invited) that a host might spend real time
// picking through. Persisted to sessionStorage so navigating away --
// e.g. to the Dashboard to create a team first, then coming back --
// doesn't silently throw all of that away. Session-scoped (not
// localStorage) on purpose: this is a draft for "the next meeting I'm
// about to start," not something that should still be sitting here
// weeks later in a totally different browsing session.
const DRAFT_KEY = "collabcode:newMeetingDraft";

function loadDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function Home() {
  const [meetingId, setMeetingId] = useState("");
  const [joinPasscode, setJoinPasscode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, authFetch } = useAuth();

  const draft = loadDraft();

  // Inviting teams/people to a brand-new meeting is entirely optional --
  // collapsed by default, same pattern as the guest-join toggle on the
  // landing page, so it never gets in the way of "just start a meeting."
  const [showInvitePanel, setShowInvitePanel] = useState(draft?.showInvitePanel || false);
  const [myTeams, setMyTeams] = useState([]);
  const [selectedTeamIds, setSelectedTeamIds] = useState(draft?.selectedTeamIds || []);
  const [individualUsernames, setIndividualUsernames] = useState(draft?.individualUsernames || []);
  const [individualInput, setIndividualInput] = useState("");

  // Who's allowed to join. "open" (default) is today's behavior -- anyone
  // with the meeting ID + passcode gets in, no questions asked, which is
  // what keeps a plain "New Meeting" click zero-friction. "restricted"
  // locks the door to just the selected team(s) (plus anyone invited
  // individually, plus the host) -- picked when a host wants to run
  // something like a real interview or a private study session without
  // worrying about the link getting passed around.
  const [accessMode, setAccessMode] = useState(draft?.accessMode || "open");

  // Auto-add-to-team is mutually exclusive with "restricted" (see the
  // radio/checkbox handlers below). Only EXISTING teams can be targeted
  // (picked from the Dashboard's team list) -- there's no inline
  // "create a new team" shortcut here; teams are only ever created from
  // the Dashboard. Can select MORE THAN ONE team: with exactly one
  // selected, everyone who joins gets proposed for it, same as before.
  // With several selected, that's ambiguous for a random link-joiner, so
  // only individually invited people get auto-added, each to whichever of
  // the selected teams they're specifically assigned to below.
  const [autoTeamEnabled, setAutoTeamEnabled] = useState(draft?.autoTeamEnabled || false);
  const [autoTeamIds, setAutoTeamIds] = useState(draft?.autoTeamIds || []);
  // username -> teamId, only meaningful when autoTeamIds.length > 1.
  const [individualTeamAssignments, setIndividualTeamAssignments] = useState(draft?.individualTeamAssignments || {});

  // If we got here via Dashboard's "Start a meeting with this team"
  // button, that team should already be picked and the panel already
  // open -- not buried behind an extra click.
  const preselectTeamId = location.state?.preselectTeamId || null;

  useEffect(() => {
    if (!user) return;
    authFetch("/api/teams")
      .then((res) => res.json())
      .then((json) => setMyTeams(json.teams || []))
      .catch(() => {});
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (preselectTeamId) {
      setShowInvitePanel(true);
      setSelectedTeamIds([preselectTeamId]);
    }
  }, [preselectTeamId]);

  // Restricted and auto-add-to-team are mutually exclusive (see the radio
  // and checkbox handlers below) -- this just guards against a stale
  // sessionStorage draft saved before that rule existed ever restoring
  // both at once.
  useEffect(() => {
    if (accessMode === "restricted" && autoTeamEnabled) {
      setAutoTeamEnabled(false);
      setAutoTeamIds([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps the draft in sessionStorage in sync with every change, so
  // leaving this page (e.g. to the Dashboard) and coming back restores
  // exactly where things were left off.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          showInvitePanel,
          selectedTeamIds,
          individualUsernames,
          accessMode,
          autoTeamEnabled,
          autoTeamIds,
          individualTeamAssignments,
        })
      );
    } catch {
      // Storage can fail (private browsing, quota) -- losing the draft
      // isn't worth crashing the page over.
    }
  }, [showInvitePanel, selectedTeamIds, individualUsernames, accessMode, autoTeamEnabled, autoTeamIds, individualTeamAssignments]);

  function toggleTeam(teamId) {
    setSelectedTeamIds((prev) => (prev.includes(teamId) ? prev.filter((id) => id !== teamId) : [...prev, teamId]));
  }

  function toggleAutoTeam(teamId) {
    setAutoTeamIds((prev) => {
      const next = prev.includes(teamId) ? prev.filter((id) => id !== teamId) : [...prev, teamId];
      // Dropping a team out of the selection invalidates any per-person
      // assignments that pointed at it -- otherwise a hidden assignment
      // could silently linger for a team no longer even offered.
      if (!next.includes(teamId)) {
        setIndividualTeamAssignments((prevAssign) => {
          const copy = { ...prevAssign };
          Object.keys(copy).forEach((uname) => {
            if (copy[uname] === teamId) delete copy[uname];
          });
          return copy;
        });
      }
      return next;
    });
  }

  function assignIndividualTeam(username, teamId) {
    setIndividualTeamAssignments((prev) => {
      const next = { ...prev };
      if (next[username] === teamId) delete next[username]; // clicking the same one again clears it
      else next[username] = teamId;
      return next;
    });
  }

  function addIndividual(e) {
    e.preventDefault();
    const name = individualInput.trim();
    if (!name || individualUsernames.includes(name)) return;
    setIndividualUsernames((prev) => [...prev, name]);
    setIndividualInput("");
  }

  function removeIndividual(name) {
    setIndividualUsernames((prev) => prev.filter((n) => n !== name));
    setIndividualTeamAssignments((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  // Once a meeting's actually been created with this setup, there's no
  // reason to carry it into the next one -- clears the draft so "New
  // Meeting" starts fresh again next time, rather than the last
  // meeting's restrictions/invites silently reappearing.
  function clearDraft() {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Not worth failing over.
    }
    setShowInvitePanel(false);
    setSelectedTeamIds([]);
    setIndividualUsernames([]);
    setAccessMode("open");
    setAutoTeamEnabled(false);
    setAutoTeamIds([]);
    setIndividualTeamAssignments({});
  }

  // Teams with nobody actually in them yet are hidden from the
  // invite/restrict picker below -- notifying, or gating a meeting on, a
  // team with zero accepted members reaches nobody, so there's no point
  // cluttering that list with it. This does NOT apply to the auto-team
  // picker further up: that feature's whole point is building a team's
  // roster up from zero as people join, so an empty team is exactly what
  // you'd expect to pick there.
  const teamsWithMembers = myTeams.filter((t) => t.members.length > 0);

  // Meetings are created server-side (POST /api/rooms), not generated in
  // the browser — the server is the one issuing the meeting ID + passcode.
  // Inviting is just extra fields on the same request; a plain "New
  // Meeting" click with nothing selected behaves exactly as it always has,
  // guest or logged in.
  async function createMeeting() {
    if (accessMode === "restricted" && selectedTeamIds.length === 0) {
      setError("Select at least one team to restrict this meeting to, or switch back to open.");
      return;
    }
    if (autoTeamEnabled && autoTeamIds.length === 0) {
      setError("Choose at least one team for auto-add, or turn that option off.");
      return;
    }

    setCreating(true);
    setError("");
    try {
      const hasInvites = user && (selectedTeamIds.length > 0 || individualUsernames.length > 0);
      const isRestricted = user && accessMode === "restricted";
      const hasAutoTeam = user && autoTeamEnabled && autoTeamIds.length > 0;
      const res = hasInvites || isRestricted || hasAutoTeam
        ? await authFetch("/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              inviteTeamIds: selectedTeamIds,
              inviteUsernames: individualUsernames,
              restrictToTeamIds: isRestricted ? selectedTeamIds : [],
              autoTeamIds: hasAutoTeam ? autoTeamIds : [],
              individualTeamAssignments: hasAutoTeam && autoTeamIds.length > 1 ? individualTeamAssignments : {},
            }),
          })
        : await fetch(`${SERVER_URL}/api/rooms`, { method: "POST" });
      if (!res.ok) throw new Error("Server returned an error");
      const { roomId, passcode, autoTeamError } = await res.json();
      if (hasAutoTeam && autoTeamError) {
        // The meeting itself still got created fine -- only the
        // auto-add-to-team setup failed (most likely MongoDB isn't
        // configured on this deploy). Tell the host now, not never --
        // otherwise they'd have no idea nobody's actually being added.
        window.alert(`Meeting created, but "auto-add to team" couldn't be set up: ${autoTeamError}\n\nPeople can still join normally, they just won't be added to a team.`);
      }
      clearDraft();
      navigate(`/room/${roomId}?pwd=${passcode}`);
    } catch (err) {
      setError("Could not reach the server. Is it running?");
      setCreating(false);
    }
  }

  function joinMeeting(e) {
    e.preventDefault();
    const id = meetingId.replace(/\s+/g, "").trim();
    const pwd = joinPasscode.trim();
    if (!id || !pwd) {
      setError("Enter both the meeting ID and passcode.");
      return;
    }
    navigate(`/room/${id}?pwd=${encodeURIComponent(pwd)}`);
  }

  return (
    <div className="home">
      {/* Fixed topbar */}
      <div className="home-account-bar">
        {user ? (
          <>
            <span>
              Signed in as <strong>{user.username}</strong>
            </span>
            <Link to="/dashboard">Dashboard</Link>
            <button className="link-button" onClick={logout}>
              Log out
            </button>
          </>
        ) : (
          <>
            <Link to="/login">Log in</Link>
            <Link to="/signup">Sign up</Link>
          </>
        )}
      </div>

      {/* Main card */}
      <div className="home-card" style={{ maxWidth: 520, paddingTop: 36, paddingBottom: 36 }}>
        {/* Logo */}
        <div className="home-logo">
          <div className="home-logo-icon">⌨️</div>
          <span className="home-logo-text">CollabCode</span>
        </div>

        {/* Hero */}
        <div className="home-hero">
          <h1>Code Together,<br />In Real Time</h1>
          <p>
            A shared coding room where multiple people can write and run code together in real time.
          </p>
        </div>

        {/* Primary action */}
        <div className="home-actions">
          <button
            className="btn btn-primary"
            style={{ padding: "14px 48px", fontSize: "1rem", borderRadius: "9999px" }}
            onClick={createMeeting}
            disabled={creating}
          >
            {creating ? "Creating room…" : "✦ New Meeting"}
          </button>

          {user && (
            <div className="access-mode-toggle">
              <label className={`access-mode-option ${accessMode === "open" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="accessMode"
                  checked={accessMode === "open"}
                  onChange={() => setAccessMode("open")}
                />
                Anyone with the link can join
              </label>
              <label className={`access-mode-option ${accessMode === "restricted" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="accessMode"
                  checked={accessMode === "restricted"}
                  onChange={() => {
                    setAccessMode("restricted");
                    setShowInvitePanel(true);
                    // Only one of "restricted" and "auto-add to team" can
                    // be active at a time -- selecting restricted turns
                    // auto-add off if it was on.
                    setAutoTeamEnabled(false);
                    setAutoTeamIds([]);
                  }}
                />
                Only selected team(s) can join
              </label>
            </div>
          )}

          {/* Mutually exclusive with "restricted" above -- turning this on
              switches accessMode back to "open" if "restricted" was
              selected, and the checkbox is disabled while "restricted" is
              active, so only one of the two can be in effect at once. */}
          {user && (
            <div className="auto-team-panel">
              <label className={`auto-team-checkbox ${accessMode === "restricted" ? "auto-team-checkbox-disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={autoTeamEnabled}
                  disabled={accessMode === "restricted"}
                  onChange={(e) => {
                    setAutoTeamEnabled(e.target.checked);
                    if (e.target.checked) setAccessMode("open");
                  }}
                />
                Automatically add everyone who joins to a team
              </label>
              {accessMode === "restricted" && (
                <p className="invite-panel-hint">Only available for open meetings — not while restricted to specific teams.</p>
              )}
              {autoTeamEnabled && (
                myTeams.length === 0 ? (
                  <p className="invite-panel-empty">
                    No teams yet — <Link to="/dashboard">create one from your Dashboard</Link>.
                  </p>
                ) : (
                  <>
                    <div className="invite-team-pills">
                      {myTeams.map((team) => (
                        <button
                          type="button"
                          key={team.id}
                          className={`invite-team-pill ${autoTeamIds.includes(team.id) ? "selected" : ""}`}
                          onClick={() => toggleAutoTeam(team.id)}
                        >
                          {autoTeamIds.includes(team.id) && <span className="invite-pill-check">✓</span>}
                          {team.name}
                          <span className="invite-pill-count">{team.members.length}</span>
                        </button>
                      ))}
                    </div>
                    {autoTeamIds.length > 1 && (
                      <p className="invite-panel-hint">
                        Multiple teams selected — only people you invite individually below and assign to one of
                        these teams will be auto-added. Anyone else who just joins the link won't be.
                      </p>
                    )}
                  </>
                )
              )}
            </div>
          )}

          {user && (
            <button
              type="button"
              className="link-button invite-panel-toggle"
              onClick={() => setShowInvitePanel((v) => !v)}
            >
              {showInvitePanel
                ? "Hide invite options"
                : selectedTeamIds.length + individualUsernames.length > 0
                ? `${selectedTeamIds.length + individualUsernames.length} selected to invite — edit`
                : accessMode === "restricted"
                ? "+ Choose who's allowed in (required)"
                : "+ Invite people to this meeting (optional)"}
            </button>
          )}

          {user && showInvitePanel && (
            <div className="invite-panel">
              <div className="invite-panel-section">
                <div className="invite-panel-label">
                  {accessMode === "restricted" ? "Team(s) allowed to join" : "Invite teams"}
                </div>
                {accessMode === "restricted" && (
                  <p className="invite-panel-hint">
                    Only members of the team(s) you pick here (plus you) will be able to join this meeting.
                    Accepting an invite to one of these teams later still gets someone in while the meeting's live.
                  </p>
                )}
                {teamsWithMembers.length === 0 ? (
                  <p className="invite-panel-empty">
                    {myTeams.length === 0 ? (
                      <>No teams yet — <Link to="/dashboard">create one from your Dashboard</Link>.</>
                    ) : (
                      "None of your teams have any accepted members yet — add some from your Dashboard first."
                    )}
                  </p>
                ) : (
                  <div className="invite-team-pills">
                    {teamsWithMembers.map((team) => (
                      <button
                        type="button"
                        key={team.id}
                        className={`invite-team-pill ${selectedTeamIds.includes(team.id) ? "selected" : ""}`}
                        onClick={() => toggleTeam(team.id)}
                      >
                        {selectedTeamIds.includes(team.id) && <span className="invite-pill-check">✓</span>}
                        {team.name}
                        <span className="invite-pill-count">{team.members.length}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="invite-panel-section">
                <div className="invite-panel-label">Invite individually</div>
                <form className="invite-individual-form" onSubmit={addIndividual}>
                  <input
                    value={individualInput}
                    onChange={(e) => setIndividualInput(e.target.value)}
                    placeholder="Username"
                  />
                  <button type="submit" disabled={!individualInput.trim()}>
                    + Add
                  </button>
                </form>
                {individualUsernames.length > 0 && (
                  <div className="individual-invite-list">
                    {individualUsernames.map((name) => (
                      <div className="individual-invite-row" key={name}>
                        <button
                          type="button"
                          className="invite-team-pill selected"
                          onClick={() => removeIndividual(name)}
                          title="Remove"
                        >
                          {name} ✕
                        </button>
                        {autoTeamEnabled && autoTeamIds.length > 1 && (
                          <div className="individual-team-assign">
                            <span className="individual-team-assign-label">→ team:</span>
                            {autoTeamIds.map((teamId) => {
                              const team = myTeams.find((t) => t.id === teamId);
                              if (!team) return null;
                              const assigned = individualTeamAssignments[name] === teamId;
                              return (
                                <button
                                  type="button"
                                  key={teamId}
                                  className={`mini-team-pill ${assigned ? "selected" : ""}`}
                                  onClick={() => assignIndividualTeam(name, teamId)}
                                >
                                  {team.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="join-divider">or join an existing room</div>

        {/* Join form */}
        <form className="join-form" onSubmit={joinMeeting}>
          <input
            value={meetingId}
            onChange={(e) => setMeetingId(e.target.value)}
            placeholder="Meeting ID"
          />
          <input
            value={joinPasscode}
            onChange={(e) => setJoinPasscode(e.target.value)}
            placeholder="Passcode"
          />
          <button className="btn btn-ghost" type="submit">Join</button>
        </form>

        {error && <div className="home-error">{error}</div>}

        {!user && (
          <p className="auth-switch" style={{ marginTop: 20 }}>
            <Link to="/signup">Create a free account</Link> to unlock Dashboard, Invites &amp; Teams.
          </p>
        )}
      </div>
    </div>
  );
}

export default Home;
