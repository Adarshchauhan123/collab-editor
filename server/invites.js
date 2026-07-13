// Direct, in-platform meeting invites between registered users — "invite
// this specific person to this specific meeting," as an alternative to
// copying a link out to some other app. Separate from teams.js, which
// handles the different "join my recurring group" flow.

const db = require("./db");
const { Invite, User } = require("./models");

async function createInvite({ fromUsername, toUsername, roomId, passcode }) {
  if (!db.isConnected()) {
    throw new Error("Invites aren't available right now — the project owner needs to set MONGODB_URI (see README).");
  }
  if (toUsername === fromUsername) {
    throw new Error("You can't invite yourself.");
  }
  const target = await User.findOne({ username: toUsername }).lean();
  if (!target) {
    throw new Error(`No account found for "${toUsername}".`);
  }
  const invite = await Invite.create({ fromUsername, toUsername, roomId, passcode, status: "pending" });
  return { id: invite._id.toString(), toUsername };
}

async function listPendingInvitesFor(username) {
  if (!db.isConnected()) return [];
  try {
    const docs = await Invite.find({ toUsername: username, status: "pending" }).sort({ createdAt: -1 }).lean();
    return docs.map((d) => ({
      id: d._id.toString(),
      fromUsername: d.fromUsername,
      roomId: d.roomId,
      passcode: d.passcode,
      createdAt: d.createdAt,
    }));
  } catch (err) {
    console.warn(`Failed to load invites for ${username}:`, err.message);
    return [];
  }
}

async function respondToInvite(id, username, accept) {
  const invite = await Invite.findOne({ _id: id, toUsername: username });
  if (!invite) throw new Error("Invite not found.");
  invite.status = accept ? "accepted" : "declined";
  await invite.save();
  return invite;
}

module.exports = { createInvite, listPendingInvitesFor, respondToInvite };
