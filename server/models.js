// Extra Mongoose models for the account layer: real accounts, in-platform
// invites, teams, and saved sessions. Kept separate from db.js, which owns
// the actual connection lifecycle (connectDB) and the original Room model —
// these schemas just reuse that same connection, so nothing about the
// existing, already-shipped persistence code had to change to add this.

const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true, trim: true },
  email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// A direct meeting invite from one registered user to another. Separate
// from Team invites below — this is "come join this one specific meeting,"
// not "join my team." toUsername is indexed since dashboards query by it.
const inviteSchema = new mongoose.Schema({
  fromUsername: { type: String, required: true },
  toUsername: { type: String, required: true, index: true },
  roomId: { type: String, required: true },
  passcode: { type: String, required: true },
  status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
});

// Each host has at most one team (found by hostUsername), which grows over
// time: `pending` is everyone who's joined one of the host's Team-Mode
// meetings and hasn't responded yet; `members` is everyone who accepted.
// One team per host (not many named teams) matches how this was described —
// a single, growing group the host builds up, not a team-picker UI.
const teamSchema = new mongoose.Schema({
  hostUsername: { type: String, required: true, unique: true, index: true },
  members: { type: [String], default: [] },
  pending: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

// A snapshot of a room's WHOLE FILE TREE, explicitly pushed by the host to
// a participant's dashboard. Deliberately host-triggered rather than
// automatic — see README's Design decisions for why (e.g. an interviewer
// may not want a candidate keeping the exact interview solution). Stores
// every file (path -> content), not just one — matches the multi-file
// workspace feature.
const savedSessionSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true }, // whose dashboard this appears on
  roomId: { type: String, required: true },
  // Mixed, NOT Mongoose's Map type: Mongoose's Map casts every key against
  // its own internal dot-notation path resolution, and REJECTS any key
  // containing a "." -- which every real filename has ("main.js",
  // "main.cpp"). That mismatch silently failed every save (caught and
  // swallowed as an error, surfacing as "Saved to 0 dashboards" with no
  // indication why). Mixed stores the plain path->content object as-is.
  files: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  sharedBy: { type: String, required: true },
  sharedAt: { type: Date, default: Date.now },
});

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Invite = mongoose.models.Invite || mongoose.model("Invite", inviteSchema);
const Team = mongoose.models.Team || mongoose.model("Team", teamSchema);
const SavedSession = mongoose.models.SavedSession || mongoose.model("SavedSession", savedSessionSchema);

module.exports = { User, Invite, Team, SavedSession };
