import { useTheme } from "./ThemeContext";

// A single floating button, present on every page (rendered once in
// App.jsx rather than per-page) so switching themes doesn't depend on
// which screen you're currently on. Bottom-right, out of the way of the
// sticky headers/icon rails every page already has along the top and
// left edges.
function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === "light";

  return (
    <button
      className="theme-toggle"
      onClick={toggleTheme}
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
    >
      {isLight ? "🌙" : "☀️"}
    </button>
  );
}

export default ThemeToggle;
