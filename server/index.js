// Day 3 server: adds a code-EXECUTION proxy on top of Day 2's rooms.
// Day 5+: adds a persistence layer (see db.js) so room files survive a
// server restart/redeploy instead of living only in memory.
// Day 5+: adds a host/permission system — one user per room is the "host"
// and controls who else is allowed to type, mirroring a driver/navigator
// pair-programming setup or an interviewer controlling a candidate's access.
// Day 5+: adds Zoom-style meeting invites — every room is created via
// POST /api/rooms, which returns a server-issued meeting ID and passcode.
// Joining now REQUIRES the correct passcode, checked here on the server,
// so a room can't be entered just by guessing/knowing its ID.
// Day 5+: adds an "Ask AI" coding helper (see ai.js), gated the same way
// as write access — host-only by default, host can open it to everyone.
// Day 5+: adds optional accounts (auth.js/models.js) layered on top of
// everything above — guests can still join by name with zero login, same
// as always. Logging in additionally unlocks in-platform invites
// (invites.js), Team Mode (teams.js), and saving a session's files to
// participants' dashboards (sessions.js). See README's Design decisions
// for why this stayed additive rather than gating the app behind auth.
// Day 5+: adds a multi-file workspace — a room now holds a whole flat
// path->content map (a folder is a path ending in "/") instead of one code
// string, synced per-file over Socket.io, with a ZIP download endpoint and
// live remote cursor positions on top of it. See README's Design decisions
// for why this is a flat map rather than a nested tree structure.
//
// The "Run" button on the client sends { language, code } (the currently
// OPEN file's content and its extension-detected language) to this server.
// This server forwards that to Wandbox (https://wandbox.org) — a free,
// keyless online compiler service — and relays back stdout/stderr.
//
// History of this endpoint, for the record:
//   1. Started with Piston (free, keyless) — its public API started
//      requiring manual whitelist approval partway through the build.
//   2. Switched to Judge0 via RapidAPI — works well, but RapidAPI requires
//      a card on file even for the "free" tier (a refundable hold) and the
//      free quota is small/pay-per-use beyond it.
//   3. Switched to Wandbox — free, keyless, no card anywhere, no signup.
//      Trade-off: Wandbox has no formal SLA/uptime guarantee and is
//      maintained by one person, so it's better for a portfolio demo than
//      for anything that needs to be rock-solid in production.
//
// Why proxy instead of calling the execution API directly from the browser?
// 1. Keeps our usage of the third-party API controllable from one place
//    (rate limiting, error handling, swapping providers later).
// 2. Lets us do our own timeout/error handling and hide the exact request
//    shape from the client.
// 3. If we ever add a provider that DOES need a secret key, that key never
//    has to touch client-side code — the proxy pattern is already in place.

const express = require("express");
const cors = require("cors");
const http = require("http");
const crypto = require("crypto");
const archiver = require("archiver");
const { Server } = require("socket.io");
const db = require("./db");
const ai = require("./ai");
const auth = require("./auth");
const invites = require("./invites");
const teams = require("./teams");
const sessions = require("./sessions");
const messages = require("./messages");
const { User } = require("./models");

// In production this should be the exact URL of the deployed frontend
// (e.g. https://your-app.vercel.app), not "*" — restricting it is what
// stops some other website from making requests against your API using a
// visitor's browser. Defaults to "*" for local development convenience.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Collab editor server is running.");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
  },
});

// --- Room state (Day 2), now backed by MongoDB underneath (see db.js) ---
// roomId -> { path: content } — the room's whole file tree, fast in-memory
// cache. A path ending in "/" is a FOLDER MARKER (its content is always
// ""); there's no separate nested structure, the tree just falls out of
// the paths themselves (same trick flat object stores like S3 use for
// "folders"). See README's Design decisions for why this is flat, not a
// nested tree of objects.
const roomFiles = new Map();
const roomUsers = new Map(); // roomId -> Map(socketId -> username)

// roomId -> passcode. Populated when a meeting is created (POST /api/rooms)
// and kept for the lifetime of the server process, independent of whether
// anyone's currently in the room — a meeting's ID+passcode should still
// work to rejoin after everyone's left, same as a real Zoom meeting link
// doesn't expire just because the call emptied out. This is NOT cleared
// when a room goes empty (unlike roomFiles/roomEditors/roomAIEnabled below).
const roomPasscodes = new Map();

// roomId -> Set(username) | undefined. Undefined (the default) means "open
// meeting" -- anyone with the ID+passcode can join, exactly as this app has
// always worked. When a host creates a meeting with accessMode "restricted",
// this is set to the snapshot of who's allowed in (selected teams' accepted
// members + individually invited usernames + the host themself), computed
// ONCE at creation time -- not re-checked against live team membership, so
// adding someone to a team later doesn't retroactively let them into a
// meeting already running. Same lifetime rules as roomPasscodes: survives a
// room going empty, never cleared by leaveCurrentRoom.
const roomAllowedUsers = new Map();

// roomId -> teamId. Set when a host creates an OPEN meeting with the
// optional "automatically add everyone who joins to a team" box checked
// (see POST /api/rooms). Unlike roomAllowedUsers (a gate), this is a
// roster-builder: it doesn't restrict who can join, it just means every
// authenticated person who successfully joins gets PROPOSED for that
// team (pending, shown on their own Dashboard under "Team invites" to
// accept or decline -- see join-room). Same never-cleared lifetime as
// roomPasscodes/roomAllowedUsers.
const roomAutoTeam = new Map();

function generateMeetingId() {
  // 9-digit numeric, Zoom-style. This is just an identifier, not a secret —
  // the passcode below is what actually protects the room, so this doesn't
  // need to be unguessable on its own.
  return String(Math.floor(100000000 + Math.random() * 900000000));
}

function generatePasscode() {
  // 6-digit numeric, kept as a zero-padded string so a code like "042817"
  // doesn't silently lose its leading zero.
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Cleans up a client-supplied file/folder path into a safe map key: no
// leading slash, no trailing slash on files, always a trailing slash on
// folders, no empty double-slash segments, capped length. Note this is
// purely a virtual namespace — these paths are just Map/object keys, never
// touched against a real filesystem, so classic path-traversal ("..")
// isn't actually a risk here the way it would be with real file I/O; the
// validation below is about keeping the tree sane, not about security.
function normalizePath(rawPath, { isFolder } = {}) {
  if (typeof rawPath !== "string") return null;
  let p = rawPath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p || p.length > 200) return null;
  if (/\/\/+/.test(p)) return null;
  return isFolder ? `${p}/` : p;
}

// Creates a brand-new meeting: a fresh ID (retried on the astronomically
// unlikely chance of an in-memory collision) plus a passcode, persisted to
// MongoDB if configured so the meeting is still valid after a restart.
//
// Inviting people is entirely optional and layered on top of that same
// plain creation -- a guest (no account) can still create a meeting with
// zero login and zero invites, exactly as before this feature existed.
// `inviteTeamIds` (any of the caller's teams) and `inviteUsernames`
// (individual registered users) both need a real account, since both are
// just different ways of writing Invite records the caller owns.
app.post("/api/rooms", async (req, res) => {
  const { inviteTeamIds, inviteUsernames, restrictToTeamIds, autoTeamName, autoTeamId } = req.body || {};
  const wantsInvites =
    (Array.isArray(inviteTeamIds) && inviteTeamIds.length > 0) ||
    (Array.isArray(inviteUsernames) && inviteUsernames.length > 0);
  const wantsRestriction = Array.isArray(restrictToTeamIds) && restrictToTeamIds.length > 0;
  const wantsAutoTeam =
    (typeof autoTeamName === "string" && autoTeamName.trim().length > 0) ||
    (typeof autoTeamId === "string" && autoTeamId.trim().length > 0);

  // Whoever is logged in when they create a meeting becomes its permanent
  // "owner" -- see roomOwner below. A guest (no token) can still create a
  // meeting exactly as before; it just has no fixed owner, and host status
  // stays "whoever joins first," same as it always has for guest-created
  // rooms.
  const creatorUsername = auth.verifyToken(auth.extractBearerToken(req));

  if ((wantsInvites || wantsRestriction || wantsAutoTeam) && !creatorUsername) {
    return res.status(401).json({ error: "Log in to invite teams or people to a meeting." });
  }

  let roomId;
  do {
    roomId = generateMeetingId();
  } while (roomPasscodes.has(roomId));

  const passcode = generatePasscode();
  roomPasscodes.set(roomId, passcode);
  await db.createRoom(roomId, passcode);

  if (creatorUsername) roomOwner.set(roomId, creatorUsername);

  let invitedTeamCount = 0;
  const individualResults = [];
  if (creatorUsername && wantsInvites) {
    if (Array.isArray(inviteTeamIds) && inviteTeamIds.length > 0) {
      invitedTeamCount = await teams.bulkInviteTeams({
        hostUsername: creatorUsername,
        teamIds: inviteTeamIds,
        roomId,
        passcode,
      });
    }
    if (Array.isArray(inviteUsernames)) {
      for (const toUsername of inviteUsernames) {
        if (typeof toUsername !== "string" || !toUsername.trim()) continue;
        try {
          await invites.createInvite({ fromUsername: creatorUsername, toUsername: toUsername.trim(), roomId, passcode });
          individualResults.push({ username: toUsername.trim(), ok: true });
        } catch (err) {
          individualResults.push({ username: toUsername.trim(), ok: false, error: err.message });
        }
      }
    }
  }

  if (creatorUsername && wantsRestriction) {
    // Snapshot who's allowed: accepted members of the chosen team(s), any
    // individually invited usernames, and the host -- resolved via
    // listTeamsForHost so a host can only restrict to teams they actually
    // own, same ownership scoping as every other teams.js call.
    const hostTeams = await teams.listTeamsForHost(creatorUsername);
    const chosenTeams = hostTeams.filter((t) => restrictToTeamIds.includes(t.id));
    const allowed = new Set([creatorUsername]);
    chosenTeams.forEach((t) => t.members.forEach((m) => allowed.add(m)));
    if (Array.isArray(inviteUsernames)) {
      inviteUsernames.forEach((u) => typeof u === "string" && u.trim() && allowed.add(u.trim()));
    }
    roomAllowedUsers.set(roomId, allowed);
  }

  let resolvedAutoTeamName = null;
  let autoTeamError = null;
  if (creatorUsername && wantsAutoTeam) {
    try {
      let team;
      if (typeof autoTeamId === "string" && autoTeamId.trim()) {
        // Picked one of the host's existing teams instead of typing a new
        // name -- resolved via listTeamsForHost so a host can only wire an
        // auto-add meeting up to a team they actually own, same ownership
        // scoping as every other teams.js call (e.g. restrictToTeamIds
        // above).
        const hostTeams = await teams.listTeamsForHost(creatorUsername);
        team = hostTeams.find((t) => t.id === autoTeamId.trim());
        if (!team) throw new Error("That team wasn't found.");
      } else {
        team = await teams.findOrCreateTeamByName(creatorUsername, autoTeamName);
      }
      roomAutoTeam.set(roomId, team.id);
      resolvedAutoTeamName = team.name;
    } catch (err) {
      console.warn(`Failed to set up auto-team for ${creatorUsername}:`, err.message);
      // Surfaced to the host below -- previously this failed silently, so
      // a host could check "auto-add to team" and never find out it
      // didn't actually get set up (e.g. MongoDB not configured on this
      // deploy) until people who joined never showed up anywhere.
      autoTeamError = err.message;
    }
  }

  res.json({
    roomId,
    passcode,
    invitedTeamCount,
    individualResults,
    autoTeamError,
    restricted: !!(creatorUsername && wantsRestriction),
    autoTeamName: resolvedAutoTeamName,
  });
});

// --- Host & permissions (Day 5+) ---
// Identity here is tracked by USERNAME, same as the rest of the app (the
// user list and join/leave toasts already work this way) — not by
// socket.id, because socket.id changes across a reconnect and we don't
// want a brief network drop to silently strip someone's granted access or
// demote the host. Guests aren't enforced-unique by username; logged-in
// users ARE unique (accounts enforce it at signup), and their room
// identity is taken from their verified token, not a client-supplied
// field — see join-room below.
//
// Permissions stay ROOM-LEVEL, not per-file, even with a whole file tree
// now in play: a host either trusts someone to edit in this meeting or
// doesn't, same as before — per-file grants would be a lot more UI and
// bookkeeping for a distinction that doesn't come up much in a 2-4 person
// pairing/interview room. See README's Design decisions.
const roomHost = new Map(); // roomId -> username of the current host
const roomEditors = new Map(); // roomId -> Set(username) granted write access (in addition to the host, who can always write)
const roomAIEnabled = new Map(); // roomId -> boolean, whether AI help is open to everyone (host can always use it)
const roomRunForAll = new Map(); // roomId -> boolean, whether Run is open to everyone (host can always run)

// roomId -> timestamp (ms) of when the FIRST person actually joined this
// room (not when it was merely created/scheduled via POST /api/rooms,
// which can happen well before anyone shows up -- see roomOwner below).
// Drives the elapsed-time session timer in the header. Set once, never
// reset even if the room empties and someone rejoins later, same
// reasoning as roomHost/roomOwner surviving an empty-out: the session's
// "start" is a property of the meeting, not of any one visit to it.
const roomStartedAt = new Map();

// roomId -> username of whoever created (scheduled) this meeting, if they
// were logged in at the time -- unset for guest-created rooms. This is
// what makes the meeting's real owner the durable host even if someone
// else technically connects first: see join-room (promotes the owner to
// host the moment they show up, even late) and leaveCurrentRoom (prefers
// the owner over an arbitrary remaining user when reassigning host).
// Mirrors how Zoom's meeting scheduler stays "the host" regardless of who
// clicks the join link first.
const roomOwner = new Map();

// roomId -> Set(username) of every AUTHENTICATED user who has ever joined
// this room during this server process's life. Used by "save this session
// to everyone's dashboard" (see /api/sessions/:roomId/share below) — kept
// even after the room empties out, same reasoning as roomHost below, so
// the host can still share a session shortly after everyone's left.
// NOT persisted to the database: if the server restarts between a meeting
// ending and the host clicking share, this list is lost (the files
// themselves aren't — those are still in MongoDB — just the "who was
// here" list). A documented, deliberate scope cut; see README.
const roomParticipants = new Map();

// roomId -> Array<{ username, text, timestamp }> — real-time room chat.
// Purely in-memory and ephemeral (not written to MongoDB): cleared the
// moment a room empties out, same as roomFiles/roomEditors below. Capped
// at CHAT_HISTORY_LIMIT so a long-running room's history can't grow
// without bound; a late joiner gets whatever's still in the buffer (see
// join-room's "chat-history" emit), not the full lifetime of the room.
const roomChatHistory = new Map();
const CHAT_HISTORY_LIMIT = 100;

function pushChatMessage(roomId, message) {
  if (!roomChatHistory.has(roomId)) roomChatHistory.set(roomId, []);
  const history = roomChatHistory.get(roomId);
  history.push(message);
  if (history.length > CHAT_HISTORY_LIMIT) history.shift();
}

function canUserEdit(roomId, username) {
  if (roomHost.get(roomId) === username) return true;
  const editors = roomEditors.get(roomId);
  return !!editors && editors.has(username);
}

function canUserUseAI(roomId, username) {
  if (roomHost.get(roomId) === username) return true;
  return !!roomAIEnabled.get(roomId);
}

// Run defaults to host-only -- unlike write access and AI help, running
// code actually spends the shared Wandbox quota and executes whatever's
// in the file, so a host opts THIS in rather than it being on by default.
function canUserRun(roomId, username) {
  if (roomHost.get(roomId) === username) return true;
  return !!roomRunForAll.get(roomId);
}

function broadcastPermissions(roomId) {
  io.to(roomId).emit("permissions", {
    host: roomHost.get(roomId) || null,
    editors: Array.from(roomEditors.get(roomId) || []),
  });
}

function broadcastAIAccess(roomId) {
  io.to(roomId).emit("ai-access", { enabledForAll: !!roomAIEnabled.get(roomId) });
}

function broadcastRunAccess(roomId) {
  io.to(roomId).emit("run-access", { enabledForAll: !!roomRunForAll.get(roomId) });
}

// Debounce timers for persisting file changes. We do NOT write to the
// database on every keystroke (or every file create/delete) — that would
// be a DB write per character typed, across every open room. Instead each
// change (re)schedules a save 1.5s in the future; if more changes land
// before that fires, we cancel and reschedule. Classic write-behind cache:
// reads and broadcasts are served instantly from the in-memory Map, while
// the database catches up shortly after things settle down. Structural
// changes (create/delete) go through this exact same debounce rather than
// a separate "save immediately" path — one save mechanism to reason about,
// and the room-empty flush below still guarantees nothing gets lost.
const saveTimers = new Map(); // roomId -> Timeout

function scheduleSave(roomId) {
  clearTimeout(saveTimers.get(roomId));
  const timer = setTimeout(() => {
    saveTimers.delete(roomId);
    const files = roomFiles.get(roomId);
    if (files !== undefined) db.saveRoomFiles(roomId, files);
  }, 1500);
  saveTimers.set(roomId, timer);
}

// Cancels any pending debounced save for a room and writes its current
// files immediately. Used when a room empties out, so the last few edits
// made right before everyone leaves aren't lost to the debounce window.
function flushSave(roomId) {
  clearTimeout(saveTimers.get(roomId));
  saveTimers.delete(roomId);
  const files = roomFiles.get(roomId);
  if (files !== undefined) db.saveRoomFiles(roomId, files);
}

function getUserList(roomId) {
  const users = roomUsers.get(roomId);
  return users ? Array.from(users.values()) : [];
}

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  let currentRoom = null;
  let currentUsername = null;

  function leaveCurrentRoom() {
    if (!currentRoom) return;

    socket.leave(currentRoom);
    const users = roomUsers.get(currentRoom);
    if (users) {
      users.delete(socket.id);

      if (users.size === 0) {
        // Flush any pending save immediately, then drop this room's files
        // and per-session state from the in-memory cache. Note: we do NOT
        // delete roomPasscodes, roomHost, or roomParticipants here — a
        // meeting's ID+passcode and its host identity should still work
        // to rejoin later (or to share a session afterward), same as a
        // real meeting link doesn't expire just because the call emptied
        // out.
        flushSave(currentRoom);
        roomUsers.delete(currentRoom);
        roomFiles.delete(currentRoom);
        roomEditors.delete(currentRoom);
        roomAIEnabled.delete(currentRoom);
        roomChatHistory.delete(currentRoom);
      } else {
        io.to(currentRoom).emit("user-list", getUserList(currentRoom));
        io.to(currentRoom).emit("user-left", currentUsername);

        // If the host just left but the room isn't empty, hand host status
        // to someone else so the room isn't permanently stuck read-only.
        // Prefers the meeting's actual owner/scheduler if they're still
        // connected (e.g. on another tab/device) -- they'd reclaim it on
        // their next join anyway, see join-room -- otherwise picks
        // whoever's been there longest (Map iteration order = insertion
        // order).
        if (roomHost.get(currentRoom) === currentUsername) {
          const remaining = getUserList(currentRoom);
          const owner = roomOwner.get(currentRoom);
          const nextHost = owner && remaining.includes(owner) ? owner : remaining[0];
          roomHost.set(currentRoom, nextHost);
          broadcastPermissions(currentRoom);
        }
      }
    }

    currentRoom = null;
  }

  socket.on("join-room", async ({ roomId, username, passcode, token }) => {
    // Resolve the room's real passcode BEFORE touching any existing
    // membership — if this join attempt fails, we shouldn't have kicked
    // the socket out of whatever room it was already validly in.
    let expectedPasscode = roomPasscodes.get(roomId);
    let coldFiles; // only set if we had to recover this room from the DB

    if (expectedPasscode === undefined) {
      // Unknown to this server process — check the database before giving
      // up, so a meeting created before a restart/redeploy is still valid.
      const persisted = await db.loadRoom(roomId);
      if (!persisted) {
        socket.emit("join-error", "Meeting not found. Check the meeting ID and try again.");
        return;
      }
      expectedPasscode = persisted.passcode;
      coldFiles = persisted.files;
    }

    if (passcode !== expectedPasscode) {
      socket.emit("join-error", "Incorrect passcode.");
      return;
    }

    // Identity is resolved here, BEFORE leaving whatever room this socket
    // was already in, so a restricted-meeting rejection below (like the
    // passcode check above) doesn't first kick the socket out of a room it
    // was validly in. Token wins over the client-supplied `username` for
    // logged-in users -- see the longer note further down on why.
    const verifiedUsername = auth.verifyToken(token);
    const isAuthenticated = !!verifiedUsername;
    const candidateUsername = verifiedUsername || (username || "Anonymous").trim() || "Anonymous";

    const allowedUsers = roomAllowedUsers.get(roomId);
    if (allowedUsers && (!isAuthenticated || !allowedUsers.has(candidateUsername))) {
      socket.emit("join-error", "This meeting is restricted — ask the host to invite you.");
      return;
    }

    // Validated — now it's safe to leave whatever room we were in before.
    if (currentRoom) leaveCurrentRoom();

    roomPasscodes.set(roomId, expectedPasscode);
    if (!roomFiles.has(roomId)) {
      // roomFiles can be missing here for two different reasons that used
      // to get conflated: either this server process never saw this room
      // before (handled above -- coldFiles is already set from that DB
      // lookup), OR everyone left at some point and the room-empty cleanup
      // (see leaveCurrentRoom) deleted this room's entry from roomFiles
      // WITHOUT touching roomPasscodes -- so expectedPasscode was already
      // known above and the `if` block above never ran, leaving coldFiles
      // undefined even though there's very likely real, saved work in the
      // database. Previously this fell straight through to DEFAULT_FILES
      // (empty), silently discarding a room's files the moment the last
      // person rejoined after everyone briefly left (e.g. navigating to
      // the Dashboard and back). Checking the DB here too, whenever we
      // don't already have coldFiles, closes that gap.
      if (coldFiles === undefined) {
        const persisted = await db.loadRoom(roomId);
        coldFiles = persisted ? persisted.files : undefined;
      }
      roomFiles.set(roomId, coldFiles ? { ...coldFiles } : { ...db.DEFAULT_FILES });
    }

    currentRoom = roomId;

    // Identity was already resolved (and, for restricted meetings, checked)
    // above, before we touched leaveCurrentRoom -- see the longer note up
    // there. Token wins over the client-supplied `username` for logged-in
    // users, so a session can't be spoofed into acting as another account
    // just by editing a form field before it's sent.
    currentUsername = candidateUsername;

    socket.join(roomId);

    if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Map());
    roomUsers.get(roomId).set(socket.id, currentUsername);

    if (isAuthenticated) {
      if (!roomParticipants.has(roomId)) roomParticipants.set(roomId, new Set());
      roomParticipants.get(roomId).add(currentUsername);

      // Open meeting with "auto-add everyone who joins to a team" turned
      // on at creation -- see POST /api/rooms. This proposes membership
      // (pending, shows up under the joiner's "Team invites" with
      // Accept/Decline) rather than adding them outright -- same consent
      // rule as every other way someone ends up on a team in this app.
      // Fire-and-forget: a slow or failed DB write here shouldn't hold up
      // the join itself.
      const autoTeamId = roomAutoTeam.get(roomId);
      if (autoTeamId) {
        const teamOwner = roomOwner.get(roomId);
        if (teamOwner) teams.addPendingTeamMember(teamOwner, autoTeamId, currentUsername);
      }
    }

    // First person into a room (since server start, or since it last went
    // empty) becomes the host. Everyone else starts read-only until the
    // host grants them write access.
    if (!roomHost.has(roomId)) {
      roomHost.set(roomId, currentUsername);
      roomEditors.set(roomId, new Set());
      roomAIEnabled.set(roomId, false);
      roomRunForAll.set(roomId, false);
      roomStartedAt.set(roomId, Date.now());
    } else if (roomOwner.get(roomId) === currentUsername && roomHost.get(roomId) !== currentUsername) {
      // The meeting's actual creator/scheduler has arrived, possibly after
      // someone else already got interim host from joining first -- same
      // idea as a Zoom meeting owner reclaiming host when they join late.
      // The interim host keeps their write access (they were legitimately
      // working, this isn't a punishment) but hands off host control.
      const previousHost = roomHost.get(roomId);
      roomHost.set(roomId, currentUsername);
      if (previousHost) {
        if (!roomEditors.has(roomId)) roomEditors.set(roomId, new Set());
        roomEditors.get(roomId).add(previousHost);
      }
    }

    socket.emit("files-sync", roomFiles.get(roomId));
    io.to(roomId).emit("user-list", getUserList(roomId));
    socket.to(roomId).emit("user-joined", currentUsername);
    broadcastPermissions(roomId);
    socket.emit("ai-access", { enabledForAll: !!roomAIEnabled.get(roomId) });
    socket.emit("run-access", { enabledForAll: !!roomRunForAll.get(roomId) });
    socket.emit("chat-history", roomChatHistory.get(roomId) || []);
    socket.emit("room-meta", { startedAt: roomStartedAt.get(roomId) || Date.now() });
  });

  // A single file's content changed (every keystroke, essentially — the
  // client debounces nothing on its end, same as the original single-file
  // version didn't either). Enforced here, not just hidden in the client
  // UI — a modified/rogue client could still emit this event directly, so
  // the write-access check has to live on the server to actually mean
  // anything. Ignored if the path doesn't exist or is a folder marker, so
  // this can't be used to sneak a new file in outside create-file.
  socket.on("file-change", ({ path, content }) => {
    if (!currentRoom) return;
    if (!canUserEdit(currentRoom, currentUsername)) return;
    const files = roomFiles.get(currentRoom);
    if (!files || !(path in files) || path.endsWith("/")) return;
    files[path] = typeof content === "string" ? content : "";
    socket.to(currentRoom).emit("file-change", { path, content: files[path] });
    scheduleSave(currentRoom);
  });

  // `content` is optional — the client fills it with a language-appropriate
  // starter snippet based on the new file's extension (see
  // STARTER_TEMPLATES in fileUtils.js) rather than the server guessing at
  // language from a filename. Falls back to an empty file if content isn't
  // a string, so a rogue/older client omitting it still works exactly as
  // before this feature existed.
  socket.on("create-file", ({ path, content }) => {
    if (!currentRoom) return;
    if (!canUserEdit(currentRoom, currentUsername)) return;
    const files = roomFiles.get(currentRoom);
    if (!files) return;
    const normalized = normalizePath(path, { isFolder: false });
    if (!normalized || normalized in files) return;
    files[normalized] = typeof content === "string" ? content : "";
    io.to(currentRoom).emit("files-sync", files);
    scheduleSave(currentRoom);
  });

  socket.on("create-folder", ({ path }) => {
    if (!currentRoom) return;
    if (!canUserEdit(currentRoom, currentUsername)) return;
    const files = roomFiles.get(currentRoom);
    if (!files) return;
    const normalized = normalizePath(path, { isFolder: true });
    if (!normalized || normalized in files) return;
    files[normalized] = "";
    io.to(currentRoom).emit("files-sync", files);
    scheduleSave(currentRoom);
  });

  // Deletes a file, or a folder and everything under it (prefix match on
  // the folder's path). Can leave the room with zero files — an empty
  // workspace is a normal state now (see DEFAULT_FILES in db.js), not
  // something that needs a fallback file recreated to paper over it. The
  // user creates their next file explicitly, same as their first one.
  socket.on("delete-entry", ({ path, isFolder }) => {
    if (!currentRoom) return;
    if (!canUserEdit(currentRoom, currentUsername)) return;
    const files = roomFiles.get(currentRoom);
    if (!files) return;
    const normalized = normalizePath(path, { isFolder: !!isFolder });
    if (!normalized || !(normalized in files)) return;

    if (isFolder) {
      for (const key of Object.keys(files)) {
        if (key === normalized || key.startsWith(normalized)) delete files[key];
      }
    } else {
      delete files[normalized];
    }

    io.to(currentRoom).emit("files-sync", files);
    scheduleSave(currentRoom);
  });

  // Host-only: grant or revoke another user's write access.
  socket.on("set-permission", ({ username, canEdit }) => {
    if (!currentRoom) return;
    if (roomHost.get(currentRoom) !== currentUsername) return; // not the host — ignore
    if (username === currentUsername) return; // host's own access isn't toggleable

    if (!roomEditors.has(currentRoom)) roomEditors.set(currentRoom, new Set());
    const editors = roomEditors.get(currentRoom);
    if (canEdit) editors.add(username);
    else editors.delete(username);

    broadcastPermissions(currentRoom);
  });

  // Host-only: force a currently-connected participant out of the LIVE
  // meeting right now -- distinct from the Dashboard's "remove from team"
  // (that's roster management for later; this is "get them off this call
  // immediately"). Kicks every socket this username holds in the room (in
  // case of multiple tabs/devices), by disconnecting them outright rather
  // than just removing them from `roomUsers` -- a soft removal would leave
  // their client sitting there with a stale "joined" view. The client-side
  // "kicked" handler is what actually prevents them from silently
  // auto-rejoining via the socket's normal reconnect behavior.
  socket.on("kick-user", ({ username }) => {
    if (!currentRoom) return;
    if (roomHost.get(currentRoom) !== currentUsername) return; // not the host — ignore
    if (username === currentUsername) return; // can't kick yourself

    const users = roomUsers.get(currentRoom);
    if (!users) return;
    for (const [socketId, uname] of users.entries()) {
      if (uname !== username) continue;
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) {
        targetSocket.emit("kicked");
        targetSocket.disconnect(true);
      }
    }
  });

  // Host-only: open or close AI help to everyone in the room.
  socket.on("set-ai-access", ({ enabledForAll }) => {
    if (!currentRoom) return;
    if (roomHost.get(currentRoom) !== currentUsername) return; // not the host — ignore
    roomAIEnabled.set(currentRoom, !!enabledForAll);
    broadcastAIAccess(currentRoom);
  });

  // Host-only: open or close Run to everyone in the room. Off by default
  // (see canUserRun) -- letting anyone burn the shared Wandbox quota or
  // run code the host hasn't reviewed isn't something a host should have
  // to opt OUT of; they opt in instead, same UX as the AI toggle above.
  socket.on("set-run-access", ({ enabledForAll }) => {
    if (!currentRoom) return;
    if (roomHost.get(currentRoom) !== currentUsername) return; // not the host — ignore
    roomRunForAll.set(currentRoom, !!enabledForAll);
    broadcastRunAccess(currentRoom);
  });

  // Ask the AI helper a question about the current code. Same enforcement
  // principle as file-change: the client hides the "Ask AI" box for
  // unpermitted users, but the real check happens here, server-side.
  // "kind" is opaque to this handler -- it's just echoed back on the
  // response so the client can tell a normal Ask AI question apart from
  // the canned "what input does this need" request (see analyzeInputs in
  // Room.jsx) without needing a second, near-identical handler.
  socket.on("ai-help", async ({ question, code, language, kind }) => {
    if (!currentRoom) return;
    if (!canUserUseAI(currentRoom, currentUsername)) {
      socket.emit("ai-help-response", { question, kind, error: "You don't have access to AI help in this meeting." });
      return;
    }
    if (!question || !question.trim()) return;

    const result = await ai.askAI({ question, code, language });
    socket.emit("ai-help-response", { question, kind, ...result });
  });

  // Run the current file's code. Host-only by default (see canUserRun) --
  // the host can open this to everyone with set-run-access above, same
  // pattern as Ask AI. This used to be a plain unauthenticated REST route
  // (POST /api/execute) that the client just avoided calling when the
  // button was disabled -- which meant nothing actually stopped a
  // read-only participant, or anyone who found the URL, from running code
  // directly. Moving it onto the socket connection means the same
  // identity/room context every other write-sensitive action already uses
  // (file-change, create-file, ai-help) applies here too.
  socket.on("run-code", async ({ language, code, stdin }) => {
    if (!currentRoom) return;
    if (!canUserRun(currentRoom, currentUsername)) {
      socket.emit("run-result", { error: "Only the host can run code in this meeting right now." });
      return;
    }
    const result = await executeCode({ language, code, stdin });
    socket.emit("run-result", result);
  });

  // Live cursor positions — purely ephemeral, no server-side state at all
  // (nothing to persist, nothing meaningful after a disconnect). Relayed
  // to everyone else in the room regardless of write access: seeing where
  // a read-only viewer is looking is normal in a collab editor, same as
  // Google Docs shows viewer cursors too. Not rate-limited server-side —
  // the client throttles how often it sends these (see Room.jsx), which
  // is the cheaper place to do it since it avoids the wasted round trip
  // entirely rather than dropping it after it already arrived.
  socket.on("cursor-move", ({ path, from, to }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("cursor-move", { username: currentUsername, path, from, to });
  });

  // Room chat — open to everyone in the room, no host gating (unlike Run
  // or AI help, sending a message doesn't spend a shared quota or execute
  // anything, so there's nothing here that needs to default to
  // restricted). Ephemeral: kept in the in-memory roomChatHistory buffer
  // only, never written to MongoDB, cleared when the room empties out.
  socket.on("send-chat-message", ({ text }) => {
    if (!currentRoom) return;
    if (typeof text !== "string") return;
    const trimmed = text.trim().slice(0, 2000);
    if (!trimmed) return;

    const message = { id: crypto.randomUUID(), username: currentUsername, text: trimmed, timestamp: Date.now() };
    pushChatMessage(currentRoom, message);
    io.to(currentRoom).emit("chat-message", message);
  });

  // Edit a chat message — author-only (checked against the message's
  // stored username, not just trusted from the client), same enforcement
  // principle as everything else here: the client only shows an edit
  // control on your own messages, but the real check is this one. No host
  // override for this one on purpose -- editing your own words is a
  // different thing from a host's moderation powers over code access, and
  // this app doesn't have message deletion/moderation at all yet.
  socket.on("edit-chat-message", ({ id, text }) => {
    if (!currentRoom) return;
    if (typeof id !== "string" || typeof text !== "string") return;
    const trimmed = text.trim().slice(0, 2000);
    if (!trimmed) return;

    const history = roomChatHistory.get(currentRoom);
    const message = history && history.find((m) => m.id === id);
    if (!message || message.username !== currentUsername) return;

    message.text = trimmed;
    message.edited = true;
    message.editedAt = Date.now();
    io.to(currentRoom).emit("chat-message-edited", { id, text: message.text, editedAt: message.editedAt });
  });

  socket.on("leave-room", () => {
    leaveCurrentRoom();
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    leaveCurrentRoom();
  });
});

// --- Accounts (Day 5+, optional) ---
// Everything above still works with zero login. These endpoints add real
// accounts on top: signup/login issue a JWT the client stores and sends
// back on every request that needs to prove identity (in-platform
// invites, Team Mode, saving sessions, join-room's optional `token`).
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

app.post("/api/auth/signup", async (req, res) => {
  if (!db.isConnected()) {
    return res
      .status(503)
      .json({ error: "Accounts aren't available right now — the project owner needs to set MONGODB_URI (see README)." });
  }
  const { username, email, password } = req.body || {};
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters: letters, numbers, underscores only." });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email." });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  try {
    const existing = await User.findOne({ $or: [{ username }, { email: email.toLowerCase() }] }).lean();
    if (existing) {
      return res
        .status(409)
        .json({ error: existing.username === username ? "That username is taken." : "That email is already registered." });
    }
    const passwordHash = await auth.hashPassword(password);
    await User.create({ username, email: email.toLowerCase(), passwordHash });
    res.json({ token: auth.signToken(username), username });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Could not create the account. Try again." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  if (!db.isConnected()) {
    return res
      .status(503)
      .json({ error: "Accounts aren't available right now — the project owner needs to set MONGODB_URI (see README)." });
  }
  const { username, password } = req.body || {};
  try {
    const user = await User.findOne({ username });
    const ok = user && (await auth.comparePassword(password || "", user.passwordHash));
    if (!ok) return res.status(401).json({ error: "Incorrect username or password." });
    res.json({ token: auth.signToken(username), username });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Could not log in. Try again." });
  }
});

app.get("/api/auth/me", auth.requireAuth, (req, res) => {
  res.json({ username: req.username });
});

// One aggregate endpoint for the whole dashboard, rather than four
// separate round trips from the client for something that always renders
// together.
app.get("/api/dashboard", auth.requireAuth, async (req, res) => {
  const [pendingInvites, savedSessions, myTeams, teamInvites, memberOfTeams, teamMessages] = await Promise.all([
    invites.listPendingInvitesFor(req.username),
    sessions.listSavedSessionsFor(req.username),
    teams.listTeamsForHost(req.username),
    teams.getTeamInvitesFor(req.username),
    teams.listTeamsForMember(req.username),
    messages.listMessagesFor(req.username),
  ]);
  res.json({ pendingInvites, savedSessions, myTeams, teamInvites, memberOfTeams, messages: teamMessages });
});

// --- In-platform invites (Day 5+) ---
app.post("/api/invites", auth.requireAuth, async (req, res) => {
  const { toUsername, roomId, passcode } = req.body || {};
  if (!toUsername || !roomId || !passcode) {
    return res.status(400).json({ error: "Missing fields." });
  }
  try {
    const result = await invites.createInvite({
      fromUsername: req.username,
      toUsername: toUsername.trim(),
      roomId,
      passcode,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/invites/:id/respond", auth.requireAuth, async (req, res) => {
  const { accept } = req.body || {};
  try {
    const invite = await invites.respondToInvite(req.params.id, req.username, !!accept);
    res.json({ status: invite.status });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Teams (multi-team) ---
// A host can own any number of named teams. Every mutating route below is
// scoped to `req.username` as hostUsername (via each teams.js function's
// own `{ _id: teamId, hostUsername }` query), so there's no way to rename,
// add to, or merge a team you don't own even if you know its id.

app.get("/api/teams", auth.requireAuth, async (req, res) => {
  res.json({ teams: await teams.listTeamsForHost(req.username) });
});

app.post("/api/teams", auth.requireAuth, async (req, res) => {
  try {
    const team = await teams.createTeam(req.username, (req.body || {}).name);
    res.json(team);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/teams/:teamId", auth.requireAuth, async (req, res) => {
  try {
    const team = await teams.renameTeam(req.username, req.params.teamId, (req.body || {}).name);
    res.json(team);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Propose a member directly (host-initiated), instead of them arriving via
// a meeting. Still just proposes -- they show up as "pending" until the
// person accepts from their own dashboard, same consent rule as always.
app.post("/api/teams/:teamId/members", auth.requireAuth, async (req, res) => {
  const { username } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: "Username required." });
  const added = await teams.addPendingTeamMember(req.username, req.params.teamId, username.trim());
  if (!added) {
    return res.status(400).json({ error: "Couldn't add that person (team not found, already a member, or already invited)." });
  }
  res.json({ ok: true });
});

// Host removes one person -- works whether they're an accepted member or
// still a pending invite (e.g. a mistyped username the host wants to
// retract rather than wait for a decline). See teams.js's removeMember.
app.delete("/api/teams/:teamId/members/:username", auth.requireAuth, async (req, res) => {
  try {
    const team = await teams.removeMember(req.username, req.params.teamId, req.params.username);
    res.json(team);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Host deletes the whole team. No confirmation step server-side -- the
// client asks before ever sending this.
app.delete("/api/teams/:teamId", auth.requireAuth, async (req, res) => {
  try {
    await teams.deleteTeam(req.username, req.params.teamId);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Self-service: a MEMBER leaving a team they no longer want to be part
// of, distinct from the host removing them.
app.post("/api/teams/:teamId/leave", auth.requireAuth, async (req, res) => {
  try {
    await teams.leaveTeam(req.username, req.params.teamId);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/api/teams/merge", auth.requireAuth, async (req, res) => {
  const { keepId, absorbId, name } = req.body || {};
  if (!keepId || !absorbId) return res.status(400).json({ error: "Both teams are required." });
  try {
    const team = await teams.mergeTeams(req.username, keepId, absorbId, name);
    res.json(team);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/teams/:teamId/respond", auth.requireAuth, async (req, res) => {
  const { accept } = req.body || {};
  try {
    await teams.respondToTeamInvite(req.username, req.params.teamId, !!accept);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Team Chat (persistent, Dashboard-level messaging) ---
// A host broadcasts to a whole team, or hand-picks a group/individual from
// that team's accepted members -- distinct from Room.jsx's in-room chat,
// which is ephemeral and scoped to one meeting. Recipients are always
// resolved server-side from the host's OWN teams (never trusted directly
// from the client), same ownership-scoping principle as every other
// mutating teams.js call: a host can only ever BROADCAST to a team they
// own. Individual/group messaging ("people" mode) is deliberately more
// open -- a host can message any registered username, not just their own
// teams' members (messages.sendMessage still checks every username is a
// real account, same as the individual meeting-invite flow).
app.post("/api/messages", auth.requireAuth, async (req, res) => {
  const { recipientType, teamId, usernames, text } = req.body || {};
  try {
    let toUsernames;
    let teamName = null;

    if (recipientType === "team") {
      const hostTeams = await teams.listTeamsForHost(req.username);
      const team = hostTeams.find((t) => t.id === teamId);
      if (!team) return res.status(404).json({ error: "Team not found." });
      toUsernames = team.members;
      teamName = team.name;
    } else if (recipientType === "people") {
      if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.status(400).json({ error: "Pick at least one person." });
      }
      toUsernames = usernames;
    } else {
      return res.status(400).json({ error: "Choose a team or pick people to message." });
    }

    const message = await messages.sendMessage({ fromUsername: req.username, toUsernames, teamName, text });
    res.json(message);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/messages/:id/like", auth.requireAuth, async (req, res) => {
  try {
    const message = await messages.toggleLike(req.params.id, req.username);
    res.json(message);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/messages/:id/reply", auth.requireAuth, async (req, res) => {
  try {
    const message = await messages.addReply(req.params.id, req.username, (req.body || {}).text);
    res.json(message);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Saved sessions (Day 5+) ---
// Host-only, and only for the host of THIS specific room — checked against
// the same roomHost map the socket layer uses, not just trusted from the
// client, same enforcement principle as everything else in this app.
// Shares the WHOLE file tree, not just one file.
app.post("/api/sessions/:roomId/share", auth.requireAuth, async (req, res) => {
  const { roomId } = req.params;
  if (roomHost.get(roomId) !== req.username) {
    return res.status(403).json({ error: "Only this meeting's host can share its code." });
  }

  if (!db.isConnected()) {
    return res
      .status(503)
      .json({ error: "Saved sessions aren't available right now -- the project owner needs to set MONGODB_URI (see README)." });
  }

  let files = roomFiles.get(roomId);
  if (files === undefined) {
    const persisted = await db.loadRoom(roomId);
    files = persisted ? persisted.files : db.DEFAULT_FILES;
  }

  // The host should always be included even if roomParticipants somehow
  // has no entries yet for this room (e.g. this exact socket session
  // hasn't round-tripped through join-room's participant-tracking, or the
  // room's Set exists but is empty) -- the person clicking this button is
  // by definition a logged-in participant of their own meeting.
  const known = roomParticipants.get(roomId);
  const participants = known && known.size > 0 ? Array.from(known) : [req.username];

  const { count, error } = await sessions.shareSession({ roomId, files, sharedBy: req.username, participants });
  if (error) {
    return res.status(500).json({ error: `Could not save this session: ${error}` });
  }
  res.json({ sharedWith: count });
});

// Removes ONE saved-session entry from the CALLER's own dashboard —
// nothing shared with anyone else. This exists so saved sessions don't
// just pile up forever once a user's looked at them; see
// sessions.deleteSavedSession for why this is safe to scope purely by
// (id, username) at the database level.
app.delete("/api/sessions/saved/:id", auth.requireAuth, async (req, res) => {
  const { ok, error } = await sessions.deleteSavedSession(req.username, req.params.id);
  if (!ok) return res.status(404).json({ error: error || "Not found." });
  res.json({ ok: true });
});

// --- Download as ZIP (Day 5+) ---
// Anyone who actually knows the meeting's passcode can download its files —
// same trust boundary as joining the meeting itself, checked the same way
// join-room checks it (including the cold-start fallback to the database
// for a room this server process doesn't have in memory). This is a plain
// REST GET (not a socket event) since a browser download is just a normal
// HTTP response with the right headers, streamed straight from `archiver`
// rather than buffered into memory first.
app.get("/api/rooms/:roomId/download", async (req, res) => {
  const { roomId } = req.params;
  const { passcode } = req.query;

  let expectedPasscode = roomPasscodes.get(roomId);
  let coldFiles;
  if (expectedPasscode === undefined) {
    const persisted = await db.loadRoom(roomId);
    if (!persisted) return res.status(404).json({ error: "Meeting not found." });
    expectedPasscode = persisted.passcode;
    coldFiles = persisted.files;
  }
  if (passcode !== expectedPasscode) {
    return res.status(401).json({ error: "Incorrect passcode." });
  }

  const files = roomFiles.get(roomId) || coldFiles || db.DEFAULT_FILES;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${roomId}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Zip creation error:", err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) {
      archive.append(Buffer.from(""), { name: path });
    } else {
      archive.append(content || "", { name: path });
    }
  }
  archive.finalize();
});

// --- Code execution (Day 3, via Wandbox) ---
const WANDBOX_URL = "https://wandbox.org/api/compile.json";

// A curated subset of what Wandbox supports. Compiler names come straight
// from Wandbox's own https://wandbox.org/api/list.json (fetched and
// verified directly, not guessed) — these are exact, stable identifiers,
// not something Wandbox lets you query by "language name" like Judge0 did,
// so there's no live-refresh step here; we just pin known-good versions.
const CURATED_LANGUAGES = [
  { key: "javascript", label: "JavaScript", compiler: "nodejs-20.17.0" },
  { key: "python", label: "Python", compiler: "cpython-3.13.8" },
  { key: "c++", label: "C++", compiler: "gcc-13.2.0" },
  { key: "java", label: "Java", compiler: "openjdk-jdk-22+36" },
  { key: "c", label: "C", compiler: "gcc-13.2.0-c" },
];

const compilerMap = new Map(CURATED_LANGUAGES.map((l) => [l.key, l.compiler]));

app.get("/api/languages", (req, res) => {
  res.json(CURATED_LANGUAGES.map(({ label, key }) => ({ label, language: key })));
});

// Runs code against Wandbox and normalizes its response into
// { stdout, stderr, stage } or { error }. Pulled out into its own function
// (rather than living inline in a REST handler, like it used to) so it can
// be called from the room-aware, permission-checked "run-code" socket
// event below -- see that handler for why this moved off a plain REST
// endpoint entirely: a REST route has no idea which room/user is calling
// it, so there was no way to actually enforce "host only" against it, only
// hide the button client-side. Everything meaningful about identity and
// permission in this app is enforced over the socket connection, so
// execution moved there too instead of bolting a parallel auth scheme
// onto a REST route.
async function executeCode({ language, code, stdin }) {
  if (!language || typeof code !== "string") {
    return { error: 'Request must include "language" and "code".' };
  }

  const compiler = compilerMap.get(language);
  if (!compiler) {
    return { error: `Unsupported language: ${language}` };
  }

  // 30s, not 20s: Java in particular (javac + a fresh JVM start on
  // Wandbox's end) runs noticeably slower than the scripted languages, and
  // a too-tight timeout here would silently show as "Program produced no
  // output" instead of the actual "Execution timed out" message -- since a
  // timeout returns a distinct { error } shape, not empty stdout/stderr.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const wRes = await fetch(WANDBOX_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        compiler,
        stdin: typeof stdin === "string" ? stdin : "",
        save: false,
      }),
      signal: controller.signal,
    });

    if (!wRes.ok) {
      const text = await wRes.text();
      return { error: `Execution service returned ${wRes.status}: ${text.slice(0, 200)}` };
    }

    const data = await wRes.json();

    // Wandbox's own docs: `status` (exit code) and `signal` are the two
    // fields that ONLY appear once the program actually started running —
    // program_output/program_error are conditionally present too, but
    // `status` is the one guaranteed to show up whenever execution
    // happened, so it's the most reliable single check for "did this even
    // get past compiling," rather than OR-ing across several fields that
    // could theoretically be individually present/absent.
    const ranProgram = data.status !== undefined || data.signal !== undefined;

    if (!ranProgram) {
      return {
        stdout: "",
        stderr: data.compiler_error || data.compiler_message || "Compilation failed.",
        stage: "compile",
      };
    }

    // `signal` shows up when the program was killed by a signal instead of
    // exiting normally — e.g. a segfault from bad memory access (classic
    // culprit: printf(someInt) or similar undefined behavior). This can
    // happen even when program_output/program_error are both empty, so
    // without folding it in, a crash silently looked like "no output."
    let stderr = data.program_error || "";
    if (data.signal) {
      stderr = stderr ? `${stderr}\n${data.signal}` : `Program crashed: ${data.signal}`;
    }

    return {
      stdout: data.program_output || "",
      stderr,
      stage: "run",
    };
  } catch (err) {
    if (err.name === "AbortError") {
      return { error: "Execution timed out after 20 seconds." };
    }
    console.error("Execute error:", err);
    return { error: "Failed to reach the code execution service." };
  } finally {
    clearTimeout(timeoutId);
  }
}

const PORT = process.env.PORT || 4000;

// Connect to the database (or gracefully skip persistence if MONGODB_URI
// isn't set) before accepting traffic, so the very first room join can
// already recover persisted files if there are any.
db.connectDB().finally(() => {
  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
});
