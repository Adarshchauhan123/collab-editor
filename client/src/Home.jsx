import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { SERVER_URL } from "./socket";
import { useAuth } from "./AuthContext";

function Home() {
  const [meetingId, setMeetingId] = useState("");
  const [joinPasscode, setJoinPasscode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, authFetch } = useAuth();

  // Inviting teams/people to a brand-new meeting is entirely optional --
  // collapsed by default, same pattern as the guest-join toggle on the
  // landing page, so it never gets in the way of "just start a meeting."
  const [showInvitePanel, setShowInvitePanel] = useState(false);
  const [myTeams, setMyTeams] = useState([]);
  const [selectedTeamIds, setSelectedTeamIds] = useState([]);
  const [individualUsernames, setIndividualUsernames] = useState([]);
  const [individualInput, setIndividualInput] = useState("");

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

  function toggleTeam(teamId) {
    setSelectedTeamIds((prev) => (prev.includes(teamId) ? prev.filter((id) => id !== teamId) : [...prev, teamId]));
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
  }

  // Meetings are created server-side (POST /api/rooms), not generated in
  // the browser — the server is the one issuing the meeting ID + passcode.
  // Inviting is just extra fields on the same request; a plain "New
  // Meeting" click with nothing selected behaves exactly as it always has,
  // guest or logged in.
  async function createMeeting() {
    setCreating(true);
    setError("");
    try {
      const hasInvites = user && (selectedTeamIds.length > 0 || individualUsernames.length > 0);
      const res = hasInvites
        ? await authFetch("/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inviteTeamIds: selectedTeamIds, inviteUsernames: individualUsernames }),
          })
        : await fetch(`${SERVER_URL}/api/rooms`, { method: "POST" });
      if (!res.ok) throw new Error("Server returned an error");
      const { roomId, passcode } = await res.json();
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
            <button
              type="button"
              className="link-button invite-panel-toggle"
              onClick={() => setShowInvitePanel((v) => !v)}
            >
              {showInvitePanel
                ? "Hide invite options"
                : selectedTeamIds.length + individualUsernames.length > 0
                ? `${selectedTeamIds.length + individualUsernames.length} selected to invite — edit`
                : "+ Invite people to this meeting (optional)"}
            </button>
          )}

          {user && showInvitePanel && (
            <div className="invite-panel">
              <div className="invite-panel-section">
                <div className="invite-panel-label">Invite teams</div>
                {myTeams.length === 0 ? (
                  <p className="invite-panel-empty">
                    No teams yet — <Link to="/dashboard">create one from your Dashboard</Link>.
                  </p>
                ) : (
                  <div className="invite-team-pills">
                    {myTeams.map((team) => (
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
                  <div className="invite-team-pills" style={{ marginTop: 8 }}>
                    {individualUsernames.map((name) => (
                      <button
                        type="button"
                        key={name}
                        className="invite-team-pill selected"
                        onClick={() => removeIndividual(name)}
                        title="Remove"
                      >
                        {name} ✕
                      </button>
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
