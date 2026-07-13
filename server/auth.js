// Accounts: bcrypt-hashed passwords, JWT for sessions.
//
// This layer is entirely OPTIONAL on top of everything already built —
// joining a meeting by typing a name, live sync, running code, all of it
// still works with zero login, exactly as before this feature existed.
// Logging in unlocks three things layered on top: in-platform invites,
// a personal dashboard of saved sessions, and Team mode. See README's
// Design decisions for why this stayed additive instead of gating the
// whole app behind auth.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// If JWT_SECRET isn't set, generate a random one for this process instead
// of refusing to start. Tokens signed with a generated secret stop
// verifying on the next restart (everyone gets logged out) — an
// acceptable tradeoff for local dev, not for a real deploy. See README
// for setting a persistent JWT_SECRET on Render.
let usingGeneratedSecret = false;
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (() => {
    usingGeneratedSecret = true;
    return crypto.randomBytes(32).toString("hex");
  })();

if (usingGeneratedSecret) {
  console.warn(
    "JWT_SECRET is not set — using a random secret generated for this run. " +
      "Everyone will be logged out on the next restart. See README to set a persistent JWT_SECRET."
  );
}

const TOKEN_TTL = "30d";

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(username) {
  return jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Returns the username encoded in a valid, unexpired token, or null for
// anything invalid/missing/expired. Never throws — callers just treat a
// null return as "not logged in" / "guest."
function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET).sub;
  } catch {
    return null;
  }
}

function extractBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

// Express middleware for REST routes that require a logged-in user.
// Attaches req.username. Does NOT trust any username the client sends in
// the request body — identity always comes from the verified token, same
// principle used everywhere else in this app (passcodes, permissions).
function requireAuth(req, res, next) {
  const username = verifyToken(extractBearerToken(req));
  if (!username) return res.status(401).json({ error: "Log in required." });
  req.username = username;
  next();
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  verifyToken,
  extractBearerToken,
  requireAuth,
};
