// Day 5+: persistence layer, backed by MongoDB Atlas's free M0 tier.
//
// Why this exists: without it, every room's files live only in a couple of
// in-memory `Map`s in index.js — a server restart or redeploy wipes
// everything. That was an acknowledged, deliberate scope cut early on. This
// file removes that limitation without touching the "live sync" code path
// at all: index.js still uses its in-memory Maps as the fast, synchronous
// source of truth for broadcasting to connected clients, but now treats the
// database as a write-behind cache underneath it (see index.js for the
// debounce logic) and a recovery source when a room is joined cold.
//
// Also stores each room's Zoom-style meeting passcode, so a server
// restart doesn't accidentally strip password-protection from a room that
// had it — see index.js's /api/rooms and join-room handler.
//
// Kept as a small function-based interface (connectDB/loadRoom/saveRoomFiles/
// createRoom) rather than spreading `mongoose` calls through index.js, so
// the rest of the server doesn't need to know or care what's on the other
// side of it — that also makes it easy to mock in tests without a real
// database connection.
//
// A room now stores a whole FILE TREE, not one code string — see the
// multi-file workspace feature. Represented as a flat map of
// path -> content, where a path ending in "/" is a folder marker (its
// "content" is always ""); this avoids a nested schema and lets the tree
// structure fall straight out of the paths themselves, same trick object
// storage services like S3 use for "folders." This is a breaking schema
// change from the earlier single `code` field — acceptable for a demo
// project with no real production data to migrate; see README.

const dns = require("dns");
const mongoose = require("mongoose");

// Force Node to resolve DNS via Google's public resolver instead of
// whatever the OS has configured. This matters on some Windows setups
// (VPN clients like Cloudflare WARP, certain antivirus/firewall products,
// or some ISPs/routers) where the `mongodb+srv://` connection scheme's
// special DNS lookup (an SRV record) gets refused by the OS-level
// resolver even though a direct query to 8.8.8.8 works fine — this line
// makes Node skip the flaky path and go straight to a resolver that works.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const MONGODB_URI = process.env.MONGODB_URI;

// Rooms start with NO files — the user creates their first one explicitly
// (see FileTree's "+ file" button and Room.jsx's createFile, which now
// also seeds new files with a language-appropriate starter snippet; see
// STARTER_TEMPLATES in fileUtils.js). This used to auto-seed every new
// room with a "main.js", which meant a file you never asked for was
// always sitting there — an empty room is a normal, expected state now,
// not something that needs papering over.
const DEFAULT_FILES = {};

const roomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true, index: true },
  // Mixed, NOT Mongoose's Map type: Mongoose's Map casts every key against
  // its own dot-notation path resolution and REJECTS any key containing a
  // "." -- which every real filename has ("main.js", "main.cpp"). With Map,
  // every save of a real multi-file room silently failed validation (the
  // error was caught and only logged server-side), meaning rooms were NOT
  // actually surviving a restart despite this feature having been shipped.
  // Mixed stores the plain path->content object as-is, no key restrictions.
  files: { type: mongoose.Schema.Types.Mixed, default: () => ({ ...DEFAULT_FILES }) },
  passcode: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
});

const Room = mongoose.models.Room || mongoose.model("Room", roomSchema);

let connected = false;

// Connects to MongoDB if MONGODB_URI is set. If it's not set, or the
// connection fails, we deliberately do NOT crash the server — persistence
// degrades to "off" and live sync/rooms/execution keep working exactly as
// they did before this feature existed. See README for how to get a free
// MongoDB Atlas connection string.
async function connectDB() {
  if (!MONGODB_URI) {
    console.warn(
      "MONGODB_URI is not set — running without persistence. Rooms will NOT survive a server restart. See README to add free MongoDB Atlas persistence."
    );
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI);
    connected = true;
    console.log("Connected to MongoDB — rooms will persist across restarts.");
  } catch (err) {
    console.warn("Could not connect to MongoDB, continuing without persistence:", err.message);
  }
}

// Creates a new room record with its passcode and a default starter file.
// Called once, when a meeting is first created via POST /api/rooms (see
// index.js) — never throws, so a DB hiccup degrades to "this room just
// won't survive a restart" rather than blocking meeting creation entirely.
async function createRoom(roomId, passcode) {
  if (!connected) return;
  try {
    await Room.updateOne(
      { roomId },
      { $setOnInsert: { roomId, passcode, files: DEFAULT_FILES } },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`Failed to persist new room ${roomId}:`, err.message);
  }
}

// Returns { files, passcode } for a room, or null if there's none stored or
// the DB isn't connected. `files` is always a plain object (path -> content),
// never a Mongoose Map, so callers don't need to know Mongoose exists.
// Never throws.
async function loadRoom(roomId) {
  if (!connected) return null;
  try {
    const doc = await Room.findOne({ roomId }).lean();
    if (!doc) return null;
    const files = doc.files && Object.keys(doc.files).length > 0 ? doc.files : DEFAULT_FILES;
    return { files, passcode: doc.passcode };
  } catch (err) {
    console.warn(`Failed to load room ${roomId} from DB:`, err.message);
    return null;
  }
}

// Overwrites a room's whole file map (passcode is set once at creation and
// never changes). Callers should NOT await this on the hot path (every
// keystroke) — index.js debounces calls to this instead, and calls it
// immediately (not debounced) for structural changes like file/folder
// create or delete, since those are comparatively rare.
async function saveRoomFiles(roomId, files) {
  if (!connected) return;
  try {
    await Room.updateOne({ roomId }, { $set: { files, updatedAt: new Date() } }, { upsert: false });
  } catch (err) {
    console.warn(`Failed to save room ${roomId} to DB:`, err.message);
  }
}

// Lets other modules (auth.js, invites.js, teams.js, sessions.js) check
// whether the database is actually available before trying a query,
// instead of each one catching the same "not connected" error separately.
function isConnected() {
  return connected;
}

module.exports = { connectDB, createRoom, loadRoom, saveRoomFiles, Room, isConnected, DEFAULT_FILES };
