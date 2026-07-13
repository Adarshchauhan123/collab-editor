// "Save this session to everyone's dashboard" — a host-triggered snapshot
// of a room's WHOLE FILE TREE, pushed to every logged-in participant's
// personal dashboard. Deliberately host-triggered, not automatic: an
// interviewer running a mock interview in this tool might not want a
// candidate walking away with the exact solution code, so the host stays
// in control of whether/when a session gets saved at all. See README's
// Design decisions.

const db = require("./db");
const { SavedSession } = require("./models");

// `participants` is every AUTHENTICATED username who was ever in the room
// during this server process's life (tracked in-memory in index.js) —
// including the host, so hosts also get their own sessions saved to their
// own dashboard, not just everyone else's. `files` is the room's whole
// path->content map at the moment of sharing, not just one file.
async function shareSession({ roomId, files, sharedBy, participants }) {
  if (!db.isConnected()) return { count: 0, error: "database isn't connected" };
  if (participants.length === 0) return { count: 0, error: null };
  try {
    const docs = participants.map((username) => ({
      username,
      roomId,
      files,
      sharedBy,
      sharedAt: new Date(),
    }));
    await SavedSession.insertMany(docs);
    return { count: docs.length, error: null };
  } catch (err) {
    console.warn(`Failed to share session for room ${roomId}:`, err.message);
    return { count: 0, error: err.message };
  }
}

async function listSavedSessionsFor(username) {
  if (!db.isConnected()) return [];
  try {
    const docs = await SavedSession.find({ username }).sort({ sharedAt: -1 }).lean();
    return docs.map((d) => ({
      id: d._id.toString(),
      roomId: d.roomId,
      files: d.files || {},
      sharedBy: d.sharedBy,
      sharedAt: d.sharedAt,
    }));
  } catch (err) {
    console.warn(`Failed to load saved sessions for ${username}:`, err.message);
    return [];
  }
}

// Deletes ONE saved-session entry — scoped to `username` in the query
// itself (not just checked after the fact), so a user can only ever
// delete their own copy of a shared session, never someone else's, even
// if they somehow got hold of another person's saved-session id. Each
// participant got their own separate document when the session was
// shared (see shareSession above), so this never affects what anyone
// else's dashboard shows.
async function deleteSavedSession(username, id) {
  if (!db.isConnected()) return { ok: false, error: "database isn't connected" };
  try {
    const result = await SavedSession.deleteOne({ _id: id, username });
    if (result.deletedCount === 0) return { ok: false, error: "Not found." };
    return { ok: true, error: null };
  } catch (err) {
    // Covers a malformed id (CastError) the same way as "not found" --
    // either way, there's nothing to delete.
    return { ok: false, error: "Not found." };
  }
}

module.exports = { shareSession, listSavedSessionsFor, deleteSavedSession };
