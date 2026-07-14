// Direct, in-platform meeting invites between registered users — "invite
// this specific person to this specific meeting," as an alternative to
// copying a link out to some other app. Separate from teams.js, which
// handles the different "join my recurring group" flow.

const db = require("./db");
const { Invite, User, Team } = require("./models");

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

    // Some of these may have come from a team broadcast while this person
    // hadn't yet accepted that team's invite (see teams.js's
    // bulkInviteTeams) -- `requiresTeamId` is only a snapshot from
    // creation time, so whether it's STILL locked is re-checked live
    // here, against current team membership. That's what makes accepting
    // the team invite later unlock the meeting invite automatically, with
    // no extra write needed anywhere.
    const teamIds = Array.from(new Set(docs.filter((d) => d.requiresTeamId).map((d) => d.requiresTeamId)));
    let acceptedTeamIds = new Set();
    if (teamIds.length > 0) {
      const acceptedTeams = await Team.find({ _id: { $in: teamIds }, members: username }).select("_id").lean();
      acceptedTeamIds = new Set(acceptedTeams.map((t) => String(t._id)));
    }

    return docs.map((d) => ({
      id: d._id.toString(),
      fromUsername: d.fromUsername,
      roomId: d.roomId,
      passcode: d.passcode,
      createdAt: d.createdAt,
      locked: !!d.requiresTeamId && !acceptedTeamIds.has(d.requiresTeamId),
      requiresTeamName: d.requiresTeamName || null,
    }));
  } catch (err) {
    console.warn(`Failed to load invites for ${username}:`, err.message);
    return [];
  }
}

async function respondToInvite(id, username, accept) {
  const invite = await Invite.findOne({ _id: id, toUsername: username });
  if (!invite) throw new Error("Invite not found.");

  // Declining is always fine even while locked -- someone should be able
  // to say "not interested" without first having to go accept a team
  // invite they don't even want. ACCEPTING, though, is blocked server-
  // side (not just hidden client-side) until they've accepted the team
  // invite this meeting invite is tied to -- checked live, same as
  // listPendingInvitesFor, so this can't go stale.
  if (accept && invite.requiresTeamId) {
    const stillMember = await Team.exists({ _id: invite.requiresTeamId, members: username });
    if (!stillMember) {
      throw new Error(
        invite.requiresTeamName
          ? `Accept your invite to team "${invite.requiresTeamName}" first, then you can join this meeting.`
          : "Accept the related team invite first, then you can join this meeting."
      );
    }
  }

  invite.status = accept ? "accepted" : "declined";
  await invite.save();
  return invite;
}

module.exports = { createInvite, listPendingInvitesFor, respondToInvite };
