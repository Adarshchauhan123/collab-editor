// Team Mode: a host can build up any number of named, persistent groups
// (e.g. "Study Group", "Interview Panel") instead of re-sharing a meeting
// link one person at a time every time. This replaced an earlier "one team
// per host" version -- see git history if you need the old single-team
// shape.
//
// Adding someone to a team only makes them PENDING, never an automatic
// member -- they accept or decline from their own dashboard, on their own
// time, rather than being silently grouped into something or interrupted
// with a popup mid-session. That consent step applies no matter how they
// got proposed: joining a meeting that named a team, or a host directly
// typing their username into "add member."

const db = require("./db");
const { Team, Invite } = require("./models");

function serializeTeam(team) {
  return {
    id: String(team._id),
    hostUsername: team.hostUsername,
    name: team.name,
    members: team.members,
    pending: team.pending,
  };
}

// All teams a host owns/manages.
async function listTeamsForHost(hostUsername) {
  if (!db.isConnected()) return [];
  try {
    const teams = await Team.find({ hostUsername }).sort({ createdAt: 1 }).lean();
    return teams.map(serializeTeam);
  } catch (err) {
    console.warn(`Failed to list teams for ${hostUsername}:`, err.message);
    return [];
  }
}

// Teams this user has ACCEPTED membership in -- the other side of
// listTeamsForHost. Without this, a host sees their team fill up fine,
// but the person who just accepted has no way to see it exists anywhere
// on their own dashboard (only teams they host show up there otherwise).
async function listTeamsForMember(username) {
  if (!db.isConnected()) return [];
  try {
    const teams = await Team.find({ members: username }).sort({ createdAt: 1 }).lean();
    return teams.map(serializeTeam);
  } catch (err) {
    console.warn(`Failed to list member teams for ${username}:`, err.message);
    return [];
  }
}

async function createTeam(hostUsername, name) {
  if (!db.isConnected()) throw new Error("Teams aren't available right now — MONGODB_URI isn't set.");
  const trimmed = (name || "").trim().slice(0, 60);
  if (!trimmed) throw new Error("Team name can't be empty.");
  const team = await Team.create({ hostUsername, name: trimmed, members: [], pending: [] });
  return serializeTeam(team);
}

async function renameTeam(hostUsername, teamId, name) {
  if (!db.isConnected()) throw new Error("Teams aren't available right now — MONGODB_URI isn't set.");
  const trimmed = (name || "").trim().slice(0, 60);
  if (!trimmed) throw new Error("Team name can't be empty.");
  const team = await Team.findOneAndUpdate({ _id: teamId, hostUsername }, { name: trimmed }, { new: true });
  if (!team) throw new Error("Team not found.");
  return serializeTeam(team);
}

async function deleteTeam(hostUsername, teamId) {
  if (!db.isConnected()) throw new Error("Teams aren't available right now — MONGODB_URI isn't set.");
  const result = await Team.deleteOne({ _id: teamId, hostUsername });
  if (result.deletedCount === 0) throw new Error("Team not found.");
}

// Propose a member for a specific team -- from the Dashboard's "add
// member" box, or (legacy path) from join-room when a meeting names a
// target team. Never throws on its own for the join-room fire-and-forget
// case; callers that need a real error (the Dashboard's "add member"
// button) should check the return value.
async function addPendingTeamMember(hostUsername, teamId, memberUsername) {
  if (!db.isConnected() || !memberUsername || memberUsername === hostUsername) return false;
  try {
    const team = await Team.findOne({ _id: teamId, hostUsername }).lean();
    if (!team) return false;
    if (team.members.includes(memberUsername) || team.pending.includes(memberUsername)) return false;
    await Team.updateOne({ _id: teamId, hostUsername }, { $addToSet: { pending: memberUsername } });
    return true;
  } catch (err) {
    console.warn(`Failed to add pending team member for ${hostUsername}/${teamId}:`, err.message);
    return false;
  }
}

// Teams where this user is a PENDING member, awaiting their response —
// across every host, not just one.
async function getTeamInvitesFor(username) {
  if (!db.isConnected()) return [];
  try {
    const teams = await Team.find({ pending: username }).lean();
    return teams.map((t) => ({ teamId: String(t._id), teamName: t.name, hostUsername: t.hostUsername }));
  } catch (err) {
    console.warn(`Failed to load team invites for ${username}:`, err.message);
    return [];
  }
}

async function respondToTeamInvite(username, teamId, accept) {
  if (!db.isConnected()) throw new Error("Teams aren't available right now — MONGODB_URI isn't set.");
  const update = accept
    ? { $pull: { pending: username }, $addToSet: { members: username } }
    : { $pull: { pending: username } };
  const team = await Team.findOneAndUpdate({ _id: teamId, pending: username }, update, { new: true });
  if (!team) throw new Error("Team invite not found.");
  return serializeTeam(team);
}

// Removes one person from a team -- covers both "kick an accepted member"
// and "cancel a pending invite I mistyped" with the same call, since a
// username can only ever be in one of the two arrays at a time and $pull
// against both is a no-op on whichever one it isn't in.
async function removeMember(hostUsername, teamId, username) {
  if (!db.isConnected()) throw new Error("Teams aren't available right now — MONGODB_URI isn't set.");
  const team = await Team.findOneAndUpdate(
    { _id: teamId, hostUsername },
    { $pull: { members: username, pending: username } },
    { new: true }
  );
  if (!team) throw new Error("Team not found.");
  return serializeTeam(team);
}

// Self-service: a MEMBER removing themselves, as opposed to the host
// removing them (removeMember above). Only pulls from `members` -- you
// can't "leave" a team you're merely pending on, that's declining the
// invite instead (respondToTeamInvite).
async function leaveTeam(username, teamId) {
  if (!db.isConnected()) throw new Error("Teams aren't available right now — MONGODB_URI isn't set.");
  const team = await Team.findOneAndUpdate(
    { _id: teamId, members: username },
    { $pull: { members: username } },
    { new: true }
  );
  if (!team) throw new Error("You're not a member of that team.");
  return serializeTeam(team);
}

// Permanently combines two of a host's teams into one. `keepId` survives;
// `absorbId` is deleted. All members and pending invites from both are
// merged (deduplicated -- someone pending in one and already a member of
// the other ends up simply a member). `name`, if given, renames the
// surviving team; otherwise it keeps whichever name `keepId` already had.
async function mergeTeams(hostUsername, keepId, absorbId, name) {
  if (!db.isConnected()) throw new Error("Teams aren't available right now — MONGODB_URI isn't set.");
  if (keepId === absorbId) throw new Error("Can't merge a team with itself.");

  const [keep, absorb] = await Promise.all([
    Team.findOne({ _id: keepId, hostUsername }),
    Team.findOne({ _id: absorbId, hostUsername }).lean(),
  ]);
  if (!keep || !absorb) throw new Error("Team not found.");

  const mergedMembers = Array.from(new Set([...keep.members, ...absorb.members]));
  // Anyone pending in either team, minus anyone who's already a confirmed
  // member post-merge (being a member beats being pending).
  const mergedPending = Array.from(new Set([...keep.pending, ...absorb.pending])).filter(
    (u) => !mergedMembers.includes(u)
  );

  keep.members = mergedMembers;
  keep.pending = mergedPending;
  const trimmedName = (name || "").trim().slice(0, 60);
  if (trimmedName) keep.name = trimmedName;
  await keep.save();
  await Team.deleteOne({ _id: absorbId, hostUsername });

  return serializeTeam(keep);
}

// Invites every accepted member across the given teams to a freshly
// created meeting, deduplicated (someone in two selected teams only gets
// one invite). Reuses the same Invite records / dashboard flow as a
// regular one-person invite.
async function bulkInviteTeams({ hostUsername, teamIds, roomId, passcode }) {
  if (!db.isConnected() || !Array.isArray(teamIds) || teamIds.length === 0) return 0;
  try {
    const teams = await Team.find({ _id: { $in: teamIds }, hostUsername }).lean();
    const usernames = Array.from(new Set(teams.flatMap((t) => t.members)));
    if (usernames.length === 0) return 0;
    const docs = usernames.map((toUsername) => ({
      fromUsername: hostUsername,
      toUsername,
      roomId,
      passcode,
      status: "pending",
    }));
    await Invite.insertMany(docs);
    return docs.length;
  } catch (err) {
    console.warn(`Failed to bulk-invite teams for ${hostUsername}:`, err.message);
    return 0;
  }
}

module.exports = {
  listTeamsForHost,
  listTeamsForMember,
  createTeam,
  renameTeam,
  deleteTeam,
  removeMember,
  leaveTeam,
  addPendingTeamMember,
  getTeamInvitesFor,
  respondToTeamInvite,
  mergeTeams,
  bulkInviteTeams,
};
