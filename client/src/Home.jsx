import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SERVER_URL } from "./socket";
import { useAuth } from "./AuthContext";

function Home() {
  const [meetingId, setMeetingId] = useState("");
  const [joinPasscode, setJoinPasscode] = useState("");
  const [creating, setCreating] = useState(false);
  const [teamMode, setTeamMode] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { user, logout, authFetch } = useAuth();

  // Meetings are created server-side (POST /api/rooms), not generated in
  // the browser — the server is the one issuing the meeting ID + passcode.
  async function createMeeting() {
    setCreating(true);
    setError("");
    try {
      const useTeamMode = teamMode && !!user;
      const res = useTeamMode
        ? await authFetch("/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamMode: true }),
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
            <label className="team-mode-toggle">
              <input
                type="checkbox"
                checked={teamMode}
                onChange={(e) => setTeamMode(e.target.checked)}
              />
              Team Mode — auto-add everyone who joins to my team
            </label>
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
            <Link to="/signup">Create a free account</Link> to unlock Dashboard, Invites &amp; Team mode.
          </p>
        )}
      </div>
    </div>
  );
}

export default Home;
