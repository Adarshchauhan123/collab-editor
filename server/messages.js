// Persistent host -> team/group/individual messaging, living on the
// Dashboard. Distinct from Room.jsx's in-room chat, which is ephemeral
// (in-memory only, cleared the moment a room empties) and scoped to one
// specific meeting -- these messages aren't tied to any meeting at all,
// they stick around, and everyone involved (the sender AND every
// recipient) can like or reply, not just a one-on-one back-and-forth.

const db = require("./db");
const { Message, User } = require("./models");

function serializeMessage(msg) {
  return {
    id: String(msg._id),
    fromUsername: msg.fromUsername,
    toUsernames: msg.toUsernames,
    teamName: msg.teamName || null,
    text: msg.text,
    likedBy: msg.likedBy || [],
    replies: (msg.replies || []).map((r) => ({
      fromUsername: r.fromUsername,
      text: r.text,
      createdAt: r.createdAt,
    })),
    createdAt: msg.createdAt,
  };
}

// `toUsernames` must already be resolved by the caller (POST /api/messages
// works out whether this is a team broadcast, a hand-picked group, or one
// person before calling this) -- this function just validates and stores.
async function sendMessage({ fromUsername, toUsernames, teamName, text }) {
  if (!db.isConnected()) throw new Error("Messaging isn't available right now — MONGODB_URI isn't set.");
  const trimmedText = (text || "").trim().slice(0, 2000);
  if (!trimmedText) throw new Error("Message can't be empty.");

  const recipients = Array.from(new Set((toUsernames || []).filter((u) => u && u !== fromUsername)));
  if (recipients.length === 0) throw new Error("Pick at least one recipient.");

  // Only message real accounts -- same check invites.js already does for
  // individual meeting invites, so a stale/mistyped username doesn't just
  // silently vanish into a message nobody can ever see.
  const existing = await User.find({ username: { $in: recipients } }).select("username").lean();
  const validRecipients = existing.map((u) => u.username);
  if (validRecipients.length === 0) throw new Error("None of those usernames have accounts.");

  const msg = await Message.create({
    fromUsername,
    toUsernames: validRecipients,
    teamName: teamName || null,
    text: trimmedText,
  });
  return serializeMessage(msg);
}

// Every message where this user is either the sender or one of the
// recipients -- one combined inbox+sent feed, newest first.
async function listMessagesFor(username) {
  if (!db.isConnected()) return [];
  try {
    const docs = await Message.find({ $or: [{ fromUsername: username }, { toUsernames: username }] })
      .sort({ createdAt: -1 })
      .lean();
    return docs.map(serializeMessage);
  } catch (err) {
    console.warn(`Failed to load messages for ${username}:`, err.message);
    return [];
  }
}

// Toggle, not just "add" -- clicking Like again un-likes it, standard
// social-app behavior. Only the sender or a recipient can act on a
// message at all (it isn't public); enforced here rather than trusting
// the client.
async function toggleLike(messageId, username) {
  if (!db.isConnected()) throw new Error("Messaging isn't available right now — MONGODB_URI isn't set.");
  const msg = await Message.findById(messageId);
  if (!msg) throw new Error("Message not found.");
  if (msg.fromUsername !== username && !msg.toUsernames.includes(username)) {
    throw new Error("You don't have access to this message.");
  }
  const idx = msg.likedBy.indexOf(username);
  if (idx === -1) msg.likedBy.push(username);
  else msg.likedBy.splice(idx, 1);
  await msg.save();
  return serializeMessage(msg);
}

async function addReply(messageId, fromUsername, text) {
  if (!db.isConnected()) throw new Error("Messaging isn't available right now — MONGODB_URI isn't set.");
  const trimmedText = (text || "").trim().slice(0, 2000);
  if (!trimmedText) throw new Error("Reply can't be empty.");
  const msg = await Message.findById(messageId);
  if (!msg) throw new Error("Message not found.");
  if (msg.fromUsername !== fromUsername && !msg.toUsernames.includes(fromUsername)) {
    throw new Error("You don't have access to this message.");
  }
  msg.replies.push({ fromUsername, text: trimmedText });
  await msg.save();
  return serializeMessage(msg);
}

module.exports = { sendMessage, listMessagesFor, toggleLike, addReply };
