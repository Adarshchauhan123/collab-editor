import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login({ username: username.trim(), password });
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
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
        <p>
          Log in to access your dashboard, invites, and Team mode. Or{" "}
          <Link to="/">join a meeting directly</Link>.
        </p>

        <form className="auth-form" onSubmit={handleSubmit}>
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

        {error && <div className="home-error">{error}</div>}

        <p className="auth-switch">
          No account? <Link to="/signup">Sign up for free</Link>
        </p>
        <p className="auth-switch">
          <Link to="/">← Back to home</Link>
        </p>
      </div>
    </div>
  );
}

export default Login;
