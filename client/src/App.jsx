import { Routes, Route } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { ThemeProvider } from "./ThemeContext";
import ThemeToggle from "./ThemeToggle";
import Landing from "./Landing";
import Room from "./Room";
import Login from "./Login";
import Signup from "./Signup";
import Dashboard from "./Dashboard";
import "./App.css";

// "/" is the front door: Landing shows login/signup first for a logged-out
// visit, and the original create/join page (Home) once logged in — see
// Landing.jsx for why. Everything else is unchanged: a direct meeting link
// (/room/:roomId) still lets a guest join with just a name, no account
// needed, exactly as before this restructure.
//
// ThemeProvider wraps everything (it just sets an attribute on <html> —
// see ThemeContext.jsx) and ThemeToggle is rendered once, here, as a
// fixed-position floating button so every route gets it for free instead
// of needing to be added to each page individually.
function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/room/:roomId" element={<Room />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/dashboard" element={<Dashboard />} />
        </Routes>
        <ThemeToggle />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
