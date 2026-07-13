// Team Mode: a host can grow a persistent group of collaborators over
// time instead of re-sharing a meeting link one person at a time every
// week. One team per host (found by hostUsername), not a team-picker UI —
// matches the "everyone who joins gets added to one team" description this
// was built from.
//
// Joining a Team-Mode meeting only makes someone PENDING, never an
// automatic member — see index.js's join-room handler. They accept or
// decline from their own dashboard, on their own time, rather than being
// interrupted with a popup mid-session.

const db = require("./db");
const { Team, Invite } = require("./models");

// Called from index.js's join-room handler when someone (logged in, not
// the host themselves) joins a Team-Mode meeting. Fire-and-forget from the
// caller's perspective — never throws, so a DB hiccup here can't break the
// actual live join.
async function addPendingTeamMember(hostUsername, memberUsername) {
  if (!db.isConnected() || memberUsername === hostUsername) return;
  try {
    const existing = await Team.findOne({ hostUsername }).lean();
    if (existing && existing.members.includes(memberUsername)) return; // already a member, nothing to do
    await Team.findOneAndUpdate(
      { hostUsername },
      { $setOnInsert: { hostUsername }, $addToSet: { pending: memberUsername } },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`Failed to add pending team member for ${hostUsername}:`, err.message);
  }
}

// The team a given user HOSTS (not teams they belong to — see
// getTeamInvitesFor / a member's own dashboard doesn't need this).
async function getTeamForHost(hostUsername) {
  if (!db.isConnected()) return null;
  try {
    const team = await Team.findOne({ hostUsername }).lean();
    if (!team) return null;
    return { hostUsername: team.hostUsername, members: team.members, pending: team.pending };
  } catch (err) {
    console.warn(`Failed to load team for ${hostUsername}:`, err.message);
    return null;
  }
}

// Teams where this user is a PENDING member, awaiting their response.
async function getTeamInvitesFor(username) {
  if (!db.isConnected()) return [];
  try {
    const teams = await Team.find({ pending: username }).lean();
    return teams.map((t) => ({ hostUsername: t.hostUsername }));
  } catch (err) {
    console.warn(`Failed to load team invites for ${username}:`, err.message);
    return [];
  }
}

async function respondToTeamInvite(username, hostUsername, accept) {
  if (!db.isConnected()) throw new Error("Teams aren't available right now — MONGODB_URI isn't set.");
  const update = accept
    ? { $pull: { pending: username }, $addToSet: { members: username } }
    : { $pull: { pending: username } };
  const team = await Team.findOneAndUpdate({ hostUsername }, update, { new: true });
  if (!team) throw new Error("Team invite not found.");
  return team;
}

// Invites every accepted member of the host's team to a freshly created
// meeting, in one shot. Reuses the same Invite records / dashboard flow as
// a regular one-person invite — a team invite is just several of those at
// once, not a separate notification system.
async function bulkInviteTeam({ hostUsername, roomId, passcode }) {
  if (!db.isConnected()) return 0;
  try {
    const team = await Team.findOne({ hostUsername }).lean();
    if (!team || team.members.length === 0) return 0;
    const docs = team.members.map((toUsername) => ({
      fromUsername: hostUsername,
      toUsername,
      roomId,
      passcode,
      status: "pending",
    }));
    await Invite.insertMany(docs);
    return docs.length;
  } catch (err) {
    console.warn(`Failed to bulk-invite team for ${hostUsername}:`, err.message);
    return 0;
  }
}

module.exports = {
  addPendingTeamMember,
  getTeamForHost,
  getTeamInvitesFor,
  respondToTeamInvite,
  bulkInviteTeam,
};
