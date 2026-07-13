# Collab Code Editor

> A shared coding room where multiple people can write and run code together in real time — built for practicing pair-programming and technical interviews.

Login-first accounts that track who's who, a multi-file workspace with a real folder tree, live remote cursors, Zoom-style meeting invites, real-time sync, host-controlled write access, a Run button backed by a real code-execution API, persistence, an optional host-gated AI coding helper, in-app invites, saved sessions, recurring teams, and a structured ZIP download of any meeting's files. Built as a scoped, defensible portfolio project rather than a feature-complete product.

## Features

- **Accounts, front and center** — a fresh visit shows login/signup first. Accounts are how the app knows who's who across meetings, which is what invites, saved sessions, and teams are built on. This isn't a hard wall, though: a meeting link still lets a guest join with just a name, no account needed, exactly like clicking a Zoom link — see Design decisions for where the line is drawn.
- **Multi-file workspace** — a real file tree sidebar: create files and folders, delete them, organize code across multiple files instead of one shared textbox. Every file is synced live to everyone in the room; each person can browse a different file independently, and Run always compiles/runs whichever file is currently open.
- **Live cursors** — see exactly where everyone else is working, in real time, with a colored caret and name label per person, scoped to whichever file they're actually looking at.
- **Download as ZIP** — grab a meeting's entire file tree — folders and all — as a structured .zip, straight from the room.
- **Meeting invites, Zoom-style** — creating a meeting gets you a server-issued meeting ID and passcode. Share the invite link (ID + passcode baked in) for a one-click join, or hand someone the ID and passcode separately to type in manually. Either way, the server validates the passcode before letting anyone in.
- **Real-time collaborative editing** — Socket.io room-based broadcast, per file; every keystroke syncs to everyone else who has that file open.
- **Presence** — see who else is in the meeting, join/leave toasts.
- **Host & write permissions** — whoever creates the meeting is the host; everyone else starts read-only until the host explicitly grants them write access. Room-level, not per-file — see Design decisions.
- **Code execution** — a Run button that actually compiles/executes code (JavaScript, Python, C++, Java, C) via a server-side proxy to Wandbox, never on your own machine. The language is auto-detected from the open file's extension.
- **Persistence** — a meeting's whole file tree (and its passcode) survive a server restart/redeploy, backed by MongoDB Atlas's free tier (optional — the app still works without it, just without the durability).
- **Ask AI, host-gated** — a coding-help panel backed by Google Gemini, for when someone's stuck. Off for everyone but the host by default; the host can flip a toggle to open it to the whole room. Optional — leave `GEMINI_API_KEY` unset and the panel just shows a "not configured" message instead of breaking anything.
- **In-app invites** — invite another registered user to a meeting by username, from right inside the room, instead of copy-pasting a link through some other app. They see it as a pending invite on their dashboard.
- **Saved sessions** — the host can explicitly save a session's whole file tree to every logged-in participant's dashboard, so it isn't lost the moment the meeting ends. Host-triggered on purpose — see Design decisions.
- **Team Mode** — a host can grow a persistent team over time: enable Team Mode when creating a meeting, and everyone who joins (and accepts) gets added to that host's team. Later, the host can invite their whole team to a new meeting in one click.

**Explicitly cut (future work):** voice/video calling, real-time (push) notifications for invites — invites/team-invites are polled when the dashboard loads rather than pushed live, a deliberate scope cut (see Design decisions) — file/folder rename (creation and deletion are supported; renaming isn't yet), and per-file access permissions (permissions stay room-level — see Design decisions).

## Tech stack

- **Frontend:** React + Vite + React Router + CodeMirror 6 (`@codemirror/state`/`@codemirror/view` used directly for the live-cursor extension)
- **Backend:** Node.js + Express + Socket.io
- **Code execution:** Wandbox (free, keyless), proxied through the Express backend
- **Persistence:** MongoDB Atlas (free M0 tier), via Mongoose
- **AI coding help:** Google Gemini API (`gemini-3.5-flash`, free tier), proxied through the Express backend
- **Accounts:** bcrypt-hashed passwords + JWT sessions (`bcryptjs`, `jsonwebtoken`), stored in the same MongoDB Atlas cluster
- **ZIP download:** `archiver`, streamed straight from the server — no third-party service involved
- **Deploy:** Render (backend) + Vercel (frontend)

## Architecture

```
┌──────────────┐    HTTPS POST /api/rooms (create)     ┌──────────────────┐
│              │ ────────────────────────────────────▶ │                  │
│   Browser    │        WebSocket (Socket.io)           │   Node.js +      │
│  (React app  │  join-room (id+passcode+token) /       │   Express +      │
│  on Vercel)  │  file-change / create-file /           │   Socket.io      │
│              │  delete-entry / cursor-move            │  (on Render)     │
│              │ ◀─────────────────────────────────── │                  │
│              │  HTTPS /api/execute, /api/auth/*,      │                  │
│              │  /api/dashboard, /api/invites,         │                  │
│              │  /api/teams/*, /api/sessions/*,        │                  │
│              │  /api/rooms/:id/download (ZIP)         │                  │
│              │ ────────────────────────────────────▶ │                  │
└──────────────┘                                        └────────┬─────────┘
                                                                   │
                                                     ┌────────────┴────────────┐
                                                     │ HTTPS                    │ debounced writes /
                                                     ▼                          │ cold-start reads
                                           ┌──────────────────┐       ┌──────────────────┐
                                           │     Wandbox       │       │  MongoDB Atlas    │
                                           │  compiles/runs the │       │  (free M0 tier)   │
                                           │  active file       │       │  rooms (file      │
                                           └──────────────────┘       │  trees), users,   │
                                           ┌──────────────────┐       │  invites, teams,   │
                                           │   Google Gemini   │       │  saved sessions    │
                                           │  answers Ask AI    │       └──────────────────┘
                                           │  questions         │
                                           └──────────────────┘
```

The backend never executes code itself — it only relays requests to Wandbox and relays room state between connected clients. A meeting only exists once `POST /api/rooms` has issued it an ID and passcode; `join-room` checks the passcode server-side before letting anyone in, caches the room's whole file tree in memory for fast broadcasting, and writes it behind to MongoDB so it survives a restart. Every `file-change`, `create-file`, `create-folder`, and `delete-entry` is checked against the room's host/editor list server-side before being relayed or saved (see Design decisions below). The `ai-help` event goes through the same gate: the server checks whether the sender is the host or AI has been opened to the room before ever calling Gemini, and the question/answer is relayed only back to whoever asked, not broadcast to the room. Accounts, invites, teams, saved sessions, and the ZIP download are plain REST endpoints sitting alongside the Socket.io layer — `join-room` optionally accepts a JWT `token`, and if it's present and valid, the server derives the joiner's identity from it instead of trusting whatever the client sent as `username`.

## Design decisions

**Login-first, but not a hard wall.** A fresh visit to the app shows login/signup before anything else — accounts are the foundation invites, saved sessions, and teams are built on, so it made sense to put them first rather than bury them behind a "New Meeting" button. But a meeting LINK never routes through this gate: `/room/:id?pwd=...` goes straight to the room's own join screen, where a guest can still just type a name and get in, exactly like clicking a Zoom link doesn't ask you to make a Zoom account first. There's also a small "join with a meeting ID instead" toggle right on the login page for anyone who was told an ID+passcode verbally rather than handed a link. The result: accounts are the primary path, but nothing about actually *joining and coding together* — the actual core pitch of this project — requires one.

**File paths are a flat map, not a nested tree of objects.** A room's files are stored as `{ "src/utils/helper.js": "...", "assets/": "" }` — one flat object, where a path ending in `/` is a folder marker. The sidebar's actual nested tree is computed on the fly from these flat paths (splitting on `/`), both on the server (for ZIP generation) and the client (for rendering). This is the same trick object storage services like S3 use for "folders" — there's no real nested schema to keep in sync, no risk of a file and its parent folder disagreeing about where it lives, and deleting a folder is just "remove every key with this prefix," a one-line filter instead of a tree traversal.

**Room-level permissions, not per-file.** Even with a whole file tree now in play, write access is still one room-wide grant per person, the same model that already existed for the single-file version. A host either trusts someone to edit in this meeting or doesn't; per-file grants would mean a lot more UI (checkboxes per person per file) and bookkeeping for a distinction that rarely matters in the 2-4 person pairing/interview rooms this targets. If a future version needed it, the enforcement point is already isolated to one function (`canUserEdit`), so it's a contained change, not a rewrite.

**Every file is shared state; "which file is open" is purely local.** Every file's content lives in one shared room-wide object, kept in sync for everyone regardless of who's looking at it. Which file is currently displayed in the editor (`activeFile`) is deliberately NOT synced — each person can browse a different file at the same time, like a real multi-file collaborative editor (VS Code Live Share works this way too), rather than forcing the whole room to stare at whatever the host happens to have open.

**Live cursors are a manual broadcast, not a CRDT awareness protocol.** Cursor positions are relayed the same way code changes are: the client emits its own cursor position (throttled to roughly one update per 150ms, not on every single keystroke/selection tick), the server relays it to everyone else in the room tagged with the sender's username, and each client renders it via a small custom CodeMirror 6 extension (a `StateField` holding widget decorations). This is simpler than a real awareness protocol (like Yjs's, which some CRDT-based editors use) because it doesn't need to reconcile concurrent state — it's just "here's where I am right now," the same broadcast-and-relay philosophy the rest of this app's sync already uses (see the sync tradeoff below). Positions are automatically remapped through local document edits by CodeMirror's own change-tracking (so a cursor stays attached to the right character even as text shifts around it), and out-of-range positions are clamped defensively so a stale cursor from a file that changed size can't crash the editor.

**Downloading a ZIP checks the same passcode as joining, not a login.** `GET /api/rooms/:roomId/download?passcode=...` requires the correct passcode, same trust boundary as `join-room` — anyone who legitimately knows how to join the meeting can also download its files, logged in or not. Requiring an account here would be inconsistent with the rest of the app, where guests can fully participate in and read a meeting without ever signing up.

**Meeting credentials are server-issued, not client-generated.** The old version let the browser make up its own room ID and anyone who guessed or was told it could join, no questions asked. Now `POST /api/rooms` is the only way a meeting comes into existence — the server generates both the meeting ID and a 6-digit passcode and is the sole source of truth for whether a given ID+passcode pair is valid.

**Broadcast sync, not a CRDT.** Every edit is emitted to the server and relayed to everyone else with that file open — whoever's change lands last wins. This is *not* a CRDT (like Yjs, which Google Docs-style editors use), so two people editing the exact same character in the exact same file at the exact same instant can overwrite each other. Deliberate scope tradeoff: a CRDT is the "correct" solution for true concurrent editing, but substantially more complex to implement correctly, and for the room sizes this targets, last-write-wins collisions are rare and the UX cost is low.

**Code execution proxy, not client-side.** The Run button never talks to the execution API directly from the browser. Routing everything through one backend endpoint means all timeout/error handling and usage control lives in one place, and if a future provider swap ever needs a secret key, that key never has to touch client-side code.

**In-memory cache with a write-behind database, not a database on the hot path.** Every keystroke still updates a fast in-memory `Map` and broadcasts synchronously — reads and syncing never wait on a database round trip. Saving to MongoDB is debounced (1.5s after the last change) instead of firing on every keystroke or every file create/delete, which would mean a database write per character typed across every open room. A room's last state is also flushed to the database immediately when the last person leaves. If `MONGODB_URI` isn't set, this whole layer degrades gracefully — meetings just won't survive a restart, same as before this feature existed.

**Permissions enforced server-side, not just hidden in the UI.** The client disables the editor and hides the file-tree's create/delete buttons for anyone without write access, but that's cosmetic — the actual enforcement is in the `file-change`/`create-file`/`create-folder`/`delete-entry` handlers on the server, which check the sender's username against the room's host/editor list before doing anything. Passcode checking follows the exact same principle: a failed or missing passcode is rejected in `join-room` itself, not by the client just choosing not to show a "join" button.

**AI access is a room-wide toggle, not a per-user grant.** Write access is "which specific people can type" (inherently per-person); AI help is "does this room trust AI help at all" (a single yes/no the host decides once). One boolean (`roomAIEnabled`) instead of a second per-user Set. Enforced server-side on every `ai-help` request, same as everything else.

**Accounts are additive to the core join/sync/execute flow, not a gate on it.** Everything that existed before accounts — joining by name via a link, live sync, running code, AI help — still works with zero login. Logging in only unlocks the things layered on top (invites, saved sessions, Team Mode), because none of those make sense for an anonymous guest to begin with.

**Room identity comes from the verified JWT, never a client-supplied field, once someone's logged in.** `join-room` accepts an optional `token`; if it verifies, the server uses the username *encoded in the token* and ignores whatever was sent as `username` — otherwise a logged-in session could be spoofed into acting as a different account by editing a form field. Guests (no token) still work exactly as before.

**Session sharing is host-triggered, not automatic.** A host has to explicitly click "Save this session to everyone's dashboard." This tool is built for practicing technical interviews, and an interviewer running a mock interview might not want a candidate walking away with the exact solution files by default — keeping it a deliberate action keeps that judgment call with whoever's running the meeting.

**Team Mode adds people as *pending*, never automatic members.** Joining a Team-Mode meeting adds you to that team's `pending` list; you accept or decline from your own dashboard, on your own schedule, rather than a popup interrupting a live coding session.

**Invites are polled, not pushed in real time.** Sending an in-app or team invite writes a record to MongoDB; the recipient sees it the next time they load their dashboard. Real-time push would mean a second, always-on Socket.io connection for anyone sitting on their dashboard (not just inside a Room, the only place a socket connects today) — a deliberate scope cut rather than something that silently doesn't work.

## One-time setup: database (optional but recommended)

Without this, the app still works fully for guests joining via a link — meetings just won't survive a server restart (including their file trees and passcodes), and everything account-related (signup/login, invites, teams, saved sessions) returns a clear "not available" error instead of working. Setting it up takes about 5 minutes and is free forever, no card required.

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) and create a free account.
2. Create a new cluster on the **M0 (Free)** tier.
3. Under **Database Access**, create a database user with a username/password.
4. Under **Network Access**, add `0.0.0.0/0` to the IP access list (allows connections from anywhere — simplest option for a portfolio project; a stricter setup would allowlist only Render's IPs, but Render's free tier doesn't publish static IPs, so this is the practical tradeoff).
5. Click **Connect → Drivers**, copy the connection string (looks like `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`).
6. Locally: `cd server`, `cp .env.example .env`, paste it as `MONGODB_URI=...` in `.env`.
7. While you're in `.env`, also set `JWT_SECRET` to any random string (e.g. run `openssl rand -hex 32`) — this is what signs login sessions. If you skip it, the server generates a random one on startup, which works fine locally but logs everyone out on every restart.
8. When deploying (below), set both `MONGODB_URI` and `JWT_SECRET` as environment variables on Render instead of a local `.env` file.

## One-time setup: AI help (optional)

Without this, everything else still works — the Ask AI panel just shows a "not configured" message. Takes about a minute, free, no card required.

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key** and copy it.
3. Locally: `cd server`, in your `.env` file (create it from `.env.example` if you haven't already) paste it as `GEMINI_API_KEY=...`.
4. When deploying (below), set the same `GEMINI_API_KEY` as an environment variable on Render instead of a local `.env` file.

## Run it locally

**Terminal 1 — server:**
```
cd server
npm install
npm start
```

**Terminal 2 — client:**
```
cd client
npm install
npm run dev
```

Open the printed URL (usually `http://localhost:5173`). You'll land on the login/signup page — sign up (needs `MONGODB_URI` set), or use the "Have a meeting ID and passcode? Join without an account" toggle to skip straight to the old-style join flow. Once logged in, click **New Meeting** — you'll be taken straight into a room as the host, starting with one file (`main.js`) in the sidebar.

**To test the multi-file workspace, ZIP download, and live cursors:**
1. In the room, use **+ file** / **+ folder** in the sidebar to build out a small tree (e.g. `src/main.py`, `src/utils/helper.py`).
2. Open the invite link in a second tab/private window and join as a different logged-in user (or a guest). Grant it write access from the host's permissions panel.
3. Click between different files in each tab — notice each tab can have a different file open at once, and edits to whichever file is shared still land for everyone with that file open.
4. Click and move your text cursor around in one tab; the other tab should show a colored caret with your name following it, only while that tab has the SAME file open.
5. Click **Download ZIP** in the header — you should get a `.zip` with the same folder structure you built, openable in any archive tool.
6. Delete a file/folder from the sidebar (host or a granted editor) and confirm it disappears from both tabs.

**To test accounts, invites, teams, and saved sessions** (needs `MONGODB_URI` set):
1. **Sign up two accounts** — from the login page, click Sign up, create e.g. `alice` and (in a second tab/private window) `bob`.
2. **In-app invite:** as alice, click New Meeting, then use the "Invite a registered user by username" box in the room to invite `bob`. Log in as bob in another tab, go to Dashboard, and you should see the pending invite — Join takes you straight in.
3. **Team Mode:** as alice, check "Team Mode" before clicking New Meeting, then have bob join that meeting (as a logged-in user, not a guest). On bob's Dashboard, a "Team invites" card shows alice's request, which he can accept or decline.
4. **Saved sessions:** while alice (the host) and bob are both in a meeting together with a few files in it, click "Save this session to everyone's dashboard" in alice's permissions panel. Check both Dashboards — a "Saved sessions" card shows up with a "View files" button that opens a read-only file browser for that snapshot.
5. **Bulk team invite:** once bob has accepted alice's team invite, alice's Dashboard shows a "Start a meeting and invite my whole team" button under "My team."

## Put it under version control

This project isn't in git yet. Run these from the `collab-editor` folder (the root, containing both `client/` and `server/`):

```
git init
git add -A
git commit -m "Initial commit: collab code editor (accounts, multi-file workspace, live cursors, invites, teams, execution, persistence)"
```

Then create an empty repository on GitHub and push:
```
git remote add origin https://github.com/<your-username>/collab-editor.git
git branch -M main
git push -u origin main
```

## Deploy

### Backend → Render

1. Go to [Render](https://render.com), sign up (no card required for the free tier), and click **New → Web Service**.
2. Connect your GitHub repo.
3. Set **Root Directory** to `server`.
4. Build command: `npm install`. Start command: `npm start`.
5. Choose the **Free** instance type.
6. Under **Environment**, add:
   - `MONGODB_URI` — your MongoDB Atlas connection string (optional, but recommended — see above; also required for accounts/invites/teams/saved sessions to work at all)
   - `JWT_SECRET` — a random string (e.g. `openssl rand -hex 32`) — required for logins to survive a restart/redeploy
   - `GEMINI_API_KEY` — your Google AI Studio key (optional — see above)
   - `CLIENT_ORIGIN` — leave blank for now, you'll fill this in after deploying the frontend
7. Deploy. Render gives you a URL like `https://collab-editor-server.onrender.com` — copy it.

**Free tier note:** Render spins a free web service down after 15 minutes of no traffic, and spinning back up takes about a minute on the next request. This is a real, known Render behavior (not a bug). It's also exactly the scenario persistence protects against: without MongoDB, every spin-down would silently wipe all meetings (files, passcodes) — and without a fixed `JWT_SECRET`, every spin-down would also silently log everyone out.

### Frontend → Vercel

1. Go to [Vercel](https://vercel.com), sign up (no card required for the Hobby plan), and import your GitHub repo.
2. Set the project's **Root Directory** to `client`. Vercel auto-detects the Vite framework preset.
3. Under **Environment Variables**, add `VITE_SERVER_URL` = your Render backend URL from above (e.g. `https://collab-editor-server.onrender.com`).
4. Deploy. Vercel gives you a URL like `https://collab-editor.vercel.app`.

### Connect them

Go back to your Render service's environment variables and set `CLIENT_ORIGIN` to your Vercel URL, then redeploy the backend. This locks the backend down to only accept requests from your actual deployed frontend.

Open the Vercel URL, log in (or use the guest-join toggle), create a meeting, build out a couple of files, open the invite link in a second browser/tab, and confirm sync + presence + permissions + live cursors + Run + ZIP download all work end to end — not just on localhost. If you set up MongoDB, also test persistence: create a meeting, add some files, wait ~2 seconds, then trigger a redeploy on Render (or just wait for it to spin down from inactivity) and rejoin using the same ID and passcode — the whole file tree and the passcode protection should still be there.

## Talking points (prepare these regardless of who asks)

1. **"Walk me through how the sync works."** Socket.io room-based broadcast, per file; every edit is relayed server-side to everyone else who has that file open; last-write-wins, and CRDTs (Yjs) would solve the concurrent-edit collision case with more complexity.
2. **"How do invites work, and what stops someone from just guessing a meeting ID?"** Meetings don't exist until `POST /api/rooms` creates them server-side, which returns a random 9-digit ID and a separate 6-digit passcode. The ID alone doesn't get you in — `join-room` checks the passcode against what it issued, and rejects anything else with a clear error.
3. **"How do you run untrusted user code safely?"** Wandbox handles sandboxing/isolation on its own infrastructure; the Express backend proxies requests rather than executing anything locally. The language to run is auto-detected from the open file's extension rather than a manual picker, so it can't silently mismatch what's actually in the file.
4. **"How does persistence work, and why didn't you just save on every keystroke?"** A write-behind cache: the in-memory Map stays the fast path for live sync, and saves to MongoDB are debounced (1.5s after things settle) so a burst of edits or file operations becomes one database write instead of dozens. Mitigated by an immediate flush when the last person leaves a room.
5. **"How does the host/permission system work, and how do you know it's actually secure?"** First joiner becomes host; everyone else defaults to read-only until granted access, at the room level (not per-file — see below). The server independently checks every `file-change`/`create-file`/`delete-entry`/`join-room` against real server-side state before acting on it, so bypassing the UI doesn't bypass the restriction. Verified directly with automated tests that manually emit events from unpermitted users and confirm the server drops them.
6. **"Why is the file tree a flat map instead of a nested object structure?"** A flat `{ path: content }` object (folders are paths ending in `/`) means there's exactly one place a file "lives" — its key — with no chance of a file and its parent folder disagreeing about where it is. The nested tree the sidebar actually renders is computed on the fly from those flat paths, both client-side (for display) and server-side (for the ZIP export), rather than maintained as a second source of truth that could drift out of sync with the flat storage.
7. **"Why didn't you make permissions per-file, now that there's a whole file tree?"** Considered it, but write access answers "do I trust this person in this meeting," which doesn't usually change file-by-file in a 2-4 person interview/pairing room. Per-file grants would add a lot of UI and bookkeeping for a distinction that rarely comes up in practice — the existing room-level check (`canUserEdit`) is a single function, easy to reason about and already tested.
8. **"How do live cursors work — is that a CRDT thing?"** No — it's a much simpler manual broadcast over the same Socket.io connection, throttled client-side to avoid flooding the room on every keystroke. The server just relays a `{username, path, position}` tuple to everyone else; each client renders remote cursors via a small custom CodeMirror 6 extension. It only needs "where is this person right now," not conflict resolution, so a full CRDT awareness protocol like Yjs's would have been solving a harder problem than the one that actually existed.
9. **"What would you change with more time?"** CRDT-based sync, video calling, file/folder rename, per-file permissions, real-time push for invites instead of polling on dashboard load.
10. **"Why did you build this?"** Ties back to your own interview-prep grind — a tool for exactly that problem.
11. **"What broke during the build, and how did you handle it?"** The execution backend went through three providers before landing on Wandbox (free, keyless, no card) — see the git history / earlier design notes for the Piston/Judge0 detour. Every swap happened behind the same internal API contract, so the frontend needed zero changes each time.
12. **"Why is AI access a room-wide toggle instead of per-user, like write permissions?"** Write access is "which specific people can type" (per-person); AI access is "does this room trust AI help at all" (one decision the host makes once). One boolean instead of a second per-user list.
13. **"Why did you make accounts the front door instead of optional?"** Because invites, saved sessions, and teams all need a stable identity that outlives a single session — none of that works for an anonymous guest. Putting login first reflects that accounts are now central to what makes this more than a single-file scratchpad. The one thing deliberately preserved is that an actual meeting LINK still bypasses the gate entirely, because forcing signup on someone about to join a live interview would be exactly the wrong moment to add friction.
14. **"How do you know a logged-in user can't be impersonated?"** Identity for anyone logged in comes from a verified JWT, never a client-supplied field — `join-room` ignores the `username` the client sends if a valid token is attached. Same principle for every account-gated REST endpoint (`requireAuth` middleware).
15. **"Who can download a meeting's ZIP, and how is that access controlled?"** Same trust boundary as joining the meeting itself — the download endpoint requires the correct passcode, checked server-side the exact same way `join-room` checks it (including falling back to the database for a room this server process doesn't have in memory). No login required, consistent with guests being able to fully participate without an account.

## Definition of done

- [x] A fresh visit shows login/signup first; a meeting link still lets a guest join with just a name, no account required
- [x] Meetings are created with a server-issued ID + passcode, and joining requires the correct passcode, enforced server-side
- [x] Two+ users can join a meeting via a shareable link and see each other's file edits live, each browsing files independently
- [x] A real file tree: create/delete files and folders, enforced server-side against room write permissions
- [x] Live remote cursors, scoped per file, with per-user stable colors
- [x] A meeting's whole file tree can be downloaded as a structured ZIP, gated by the same passcode as joining
- [x] Host can control which users are allowed to edit, enforced server-side *(not just hidden in the client UI)*
- [x] Code executes via the Run button, with the language auto-detected from the open file, and shows real output for 3+ languages *(Wandbox, free and keyless)*
- [x] A meeting's file tree and passcode persist across a server restart *(MongoDB Atlas free tier, optional — see setup above)*
- [x] Ask AI panel gives real coding help and is off for non-hosts until the host enables it, enforced server-side *(Google Gemini, free tier, optional)*
- [x] Optional accounts work without breaking guest joining via a link, and identity is verified server-side via JWT, not trusted from the client
- [x] Logged-in users can invite another registered user to a meeting by username, and see/accept/decline it from a dashboard
- [x] A host can save a session's whole file tree to every logged-in participant's dashboard, enforced host-only server-side
- [x] Team Mode: joining a team-mode meeting proposes team membership (pending, not automatic); accepting adds you to the host's team; the host can bulk-invite the whole team to a new meeting
- [ ] Deployed and publicly accessible *(instructions above — Render + Vercel accounts are yours to create)*
- [x] README with pitch, architecture, setup steps, and design-decisions section
- [ ] Demo GIF/video recorded
- [x] Sync mechanism and its limitations documented and explainable
