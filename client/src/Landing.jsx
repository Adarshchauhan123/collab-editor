import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import Home from "./Home";

// The front door. A fresh, logged-out visit sees login/signup FIRST —
// accounts are how the app tracks who's who across meetings. Once logged
// in, this same route just renders the original create/join page (Home).
function Landing() {
  const { user, login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [showGuestJoin, setShowGuestJoin] = useState(false);
  const [meetingId, setMeetingId] = useState("");
  const [joinPasscode, setJoinPasscode] = useState("");

  if (user) {
    return <Home />;
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login({ username: username.trim(), password });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleGuestJoin(e) {
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
      <div className="home-card">
        {/* Brand */}
        <div className="home-logo">
          <div className="home-logo-icon">⌨️</div>
          <span className="home-logo-text">CollabCode</span>
        </div>

        <h1>Welcome back</h1>
        <p>Sign in to start coding with your team in real time.</p>

        <form className="auth-form" onSubmit={handleLogin}>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoFocus
          />
          <div className="password-field">
            <input
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              type={showPassword ? "text" : "password"}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "🙈" : "👁"}
            </button>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Logging in…" : "Log in →"}
          </button>
        </form>

        <p className="auth-switch">
          No account? <Link to="/signup">Sign up for free</Link>
        </p>

        {/* Guest join toggle */}
        <div className="join-divider" style={{ marginTop: 20 }}>
          <button
            className="link-button"
            onClick={() => setShowGuestJoin((v) => !v)}
            style={{ fontSize: "0.8rem" }}
          >
            {showGuestJoin ? "Hide guest join" : "Have a meeting ID? Join without an account →"}
          </button>
        </div>

        {showGuestJoin && (
          <form className="join-form" style={{ marginTop: 12 }} onSubmit={handleGuestJoin}>
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
        )}

        {error && <div className="home-error">{error}</div>}
      </div>
    </div>
  );
}

export default Landing;
