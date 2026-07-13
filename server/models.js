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

// A host can now own MULTIPLE named teams (e.g. "Study Group", "Work
// Project") -- hostUsername is indexed but no longer unique, since a host
// creates as many of these as they want. `pending` is everyone who's been
// added (via the "add member" flow) and hasn't responded yet; `members` is
// everyone who accepted. Consent still applies the same way it always
// did -- being added to a team is a proposal, not an instant membership,
// whether that add came from joining a meeting (legacy) or a host
// explicitly adding a username from the Dashboard's team management UI.
const teamSchema = new mongoose.Schema({
  hostUsername: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, default: "My Team" },
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

// A host-initiated message to a whole team (broadcast), a hand-picked
// group, or one person -- persistent and living on the Dashboard, NOT tied
// to any one meeting (unlike Room.jsx's in-room chat, which is ephemeral,
// in-memory only, and cleared the moment that room empties out).
// `toUsernames` is always the fully-resolved flat list of recipients, even
// for a team broadcast -- so a message and its thread stay intact and
// visible to everyone who originally got it even if that team is later
// renamed, has members removed, or is deleted outright. `teamName` is a
// display-only snapshot ("sent to team Study Group") for the same reason.
const messageSchema = new mongoose.Schema({
  fromUsername: { type: String, required: true, index: true },
  toUsernames: { type: [String], required: true, index: true },
  teamName: { type: String, default: null },
  text: { type: String, required: true, trim: true },
  likedBy: { type: [String], default: [] },
  replies: {
    type: [
      {
        fromUsername: String,
        text: String,
        createdAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Invite = mongoose.models.Invite || mongoose.model("Invite", inviteSchema);
const Team = mongoose.models.Team || mongoose.model("Team", teamSchema);
const SavedSession = mongoose.models.SavedSession || mongoose.model("SavedSession", savedSessionSchema);
const Message = mongoose.models.Message || mongoose.model("Message", messageSchema);

module.exports = { User, Invite, Team, SavedSession, Message };
