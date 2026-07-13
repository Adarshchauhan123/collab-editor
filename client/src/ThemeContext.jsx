import { createContext, useContext, useEffect, useState } from "react";

// Light/dark mode. Every color in the app is a CSS custom property (see
// index.css's :root and [data-theme="light"] blocks) — this context's
// only job is deciding WHICH value those properties resolve to, by
// setting a `data-theme` attribute on <html>. No component needs to know
// or care what theme is active; they just keep using var(--text-primary)
// etc. like they always have.
//
// Preference resolution order, matching what a user would actually
// expect: an explicit in-app choice (saved to localStorage) always wins;
// absent that, we defer to the OS-level prefers-color-scheme instead of
// silently forcing dark on everyone — that IS "the user's requirement"
// until they've told this app otherwise. Only if neither is available
// (very old browsers) do we fall back to dark, matching this app's
// original, only-ever-dark design.
const ThemeContext = createContext(null);

const STORAGE_KEY = "collab-editor-theme"; // "light" | "dark"

function systemPrefersLight() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: light)").matches
    : false;
}

function resolveInitialTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable (privacy mode, etc.) — fall through.
  }
  return systemPrefersLight() ? "light" : "dark";
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(resolveInitialTheme);

  // Reflect the theme onto <html data-theme="..."> so every stylesheet in
  // the app (already loaded once, globally) can react via CSS alone —
  // no per-component theme prop drilling needed.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore — worst case, the choice doesn't survive a refresh.
    }
  }, [theme]);

  // If the user never made an explicit in-app choice, keep following the
  // OS setting live (e.g. their system switches to dark at sunset).
  // Stops listening the moment they DO make an explicit choice, since at
  // that point their in-app preference should stick regardless of what
  // the OS does.
  useEffect(() => {
    let hasExplicitChoice = false;
    try {
      hasExplicitChoice = localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      hasExplicitChoice = false;
    }
    if (hasExplicitChoice || !window.matchMedia) return;

    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e) => setThemeState(e.matches ? "light" : "dark");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  function setTheme(next) {
    setThemeState(next);
  }

  function toggleTheme() {
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
  }

  const value = { theme, setTheme, toggleTheme };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
