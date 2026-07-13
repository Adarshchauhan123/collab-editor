import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { showMinimap } from "@replit/codemirror-minimap";
import { socket, SERVER_URL } from "./socket";
import { useAuth } from "./AuthContext";
import { useTheme } from "./ThemeContext";
import FileTree from "./FileTree";
import { detectLanguage, colorForUsername } from "./fileUtils";
import { remoteCursorsExtension, setRemoteCursors } from "./RemoteCursors";
import "./Room.css";

// Maps a detected language key to the CodeMirror extension that gives it
// syntax highlighting. Purely cosmetic — the execution backend doesn't
// care what color the text is, only what's in the active file's content.
const EDITOR_EXTENSIONS = {
  javascript: javascript({ jsx: true }),
  python: python(),
  "c++": cpp(),
  c: cpp(), // C and C++ share a highlighter — close enough for our purposes
  java: java(),
};

// Minimap needs a DOM element factory per CodeMirror's extension API — the
// package renders into it itself, we just have to hand it an empty <div>.
// Recomputing this fresh each time (rather than a module-level constant)
// is what @replit/codemirror-minimap's own docs show, and it's cheap.
function buildMinimapExtension() {
  return showMinimap.compute(["doc"], () => ({
    create: () => ({ dom: document.createElement("div") }),
    displayText: "blocks",
    showOverlay: "always",
  }));
}

function Room() {
  const { roomId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, token, authFetch, logout } = useAuth();
  const { theme } = useTheme();

  // A meeting invite link looks like /room/123456789?pwd=654321 — the
  // passcode rides along in the URL so clicking a link is a one-step join,
  // matching how Zoom links work. If someone lands here WITHOUT a ?pwd
  // (typed the URL by hand, or only has the raw ID), we fall back to
  // asking for it on the join gate below.
  const urlPasscode = searchParams.get("pwd") || "";

  const [guestName, setGuestName] = useState("");
  const [manualPasscode, setManualPasscode] = useState("");
  const [hasJoined, setHasJoined] = useState(false);
  const [joinError, setJoinError] = useState("");

  const passcode = urlPasscode || manualPasscode;

  // If logged in, the room identity is always the account's own username —
  // never something typed into a form field. The server enforces this too
  // (it derives identity from the JWT, ignoring any client-supplied name),
  // this is just so the UI shows the same thing. Guests still type a name.
  const joinUsername = user ? user.username : guestName;

  // Multi-file workspace: `files` is the room's whole flat path->content
  // map (a folder is a path ending in "/"), `activeFile` is whichever one
  // THIS client currently has open — every file is shared state synced to
  // everyone, but each person can independently browse a different file,
  // like a real multi-file collaborative editor. See fileUtils.js and
  // README's Design decisions.
  const [files, setFiles] = useState({});
  const [activeFile, setActiveFile] = useState(null);

  const [users, setUsers] = useState([]);
  const [toast, setToast] = useState(null);
  const [copied, setCopied] = useState("");

  // Host & permissions: `host` is the username currently in control of the
  // room; `editors` is everyone ELSE who's been granted write access. The
  // host always implicitly has write access, so they're not in `editors`.
  // Permissions stay ROOM-LEVEL (not per-file) even with a whole file tree
  // now in play — see README's Design decisions.
  const [host, setHost] = useState(null);
  const [editors, setEditors] = useState([]);

  // AI help: host-only by default, host can open it to everyone in the
  // room with one toggle (aiEnabledForAll) rather than per-user grants —
  // this is a room-wide setting, not something you hand out one person at
  // a time like write access.
  const [aiEnabledForAll, setAiEnabledForAll] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiHistory, setAiHistory] = useState([]); // [{ question, answer, error }]
  const [aiAsking, setAiAsking] = useState(false);

  // Run access: host-only by default, same pattern as Ask AI -- the host
  // can open it to everyone with one toggle rather than per-user grants.
  // Enforced server-side (see index.js's run-code handler), not just by
  // hiding this button -- see canRun below.
  const [runEnabledForAll, setRunEnabledForAll] = useState(false);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { stdout, stderr, error }

  // Stdin box: programs that read input (cin/scanf/input()) need something
  // to read, or they just run to completion with nothing printed — which
  // looks exactly like a bug ("no output") but isn't one. This gets sent
  // through untouched on every Run.
  const [stdinValue, setStdinValue] = useState("");

  // "What input does this need?" -- a canned AI question (reusing the
  // same ai-help socket flow as Ask AI, tagged kind: "inputs" so the
  // response gets routed here instead of into the Ask AI chat thread)
  // that lists what the code will read from stdin and in what order, so
  // there's no more guessing/miscounting how many lines to put in the
  // stdin box above.
  const [inputHint, setInputHint] = useState(null); // { answer, error }
  const [inputHintLoading, setInputHintLoading] = useState(false);

  // Editor display settings — genuinely wired into CodeMirror below, not
  // just UI decoration: lineNumbers toggles @uiw/react-codemirror's
  // basicSetup.lineNumbers, fontSize drives a live EditorView.theme
  // extension, and minimapEnabled conditionally includes the (real,
  // installed) @replit/codemirror-minimap extension.
  const [lineNumbersEnabled, setLineNumbersEnabled] = useState(true);
  const [minimapEnabled, setMinimapEnabled] = useState(true);
  const [fontSize, setFontSize] = useState(14);

  // Which tab of the bottom panel is showing — the execution console
  // (stdin + output) or Ask AI. Both already existed as stacked panels;
  // this just puts them behind tabs instead, matching the requested layout.
  const [activePanelTab, setActivePanelTab] = useState("console");

  // Room chat — real, working, ephemeral (see server/index.js's
  // roomChatHistory: kept in memory only, cleared when the room empties,
  // never written to MongoDB). Open to everyone, no host gating, unlike
  // Run/AI which spend a shared quota. Which tab of the right panel is
  // showing (Chat or Team) is separate from activePanelTab above.
  const [rightPanelTab, setRightPanelTab] = useState("chat");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef(null);

  // Editing your own chat message: which message id (if any) is currently
  // showing its inline edit form, and the in-progress text for it. Kept
  // separate from chatInput (the composer for NEW messages) since both
  // can't be the same field — you might be editing an old message while
  // the composer still has unrelated draft text sitting in it.
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingText, setEditingText] = useState("");

  // Editor height is user-resizable by dragging the handle below the
  // CodeMirror instance (see startEditorResize / the isResizingEditor
  // effect) rather than a fixed viewport-relative height, so a long file
  // or a small monitor isn't stuck with whatever ratio looked good on one
  // screen size.
  const [editorHeight, setEditorHeight] = useState(420);
  const [isResizingEditor, setIsResizingEditor] = useState(false);
  const resizeStartRef = useRef({ y: 0, height: 420 });

  // Session timer: `roomStartedAt` comes from the server (see room-meta —
  // set once, the first time anyone ever joins this room, and never reset
  // by a later rejoin). `elapsedSeconds` is a local ticking clock derived
  // from it, updated once a second — purely a display value, never sent
  // anywhere.
  const [roomStartedAt, setRoomStartedAt] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // In-platform invites (requires being logged in — the server checks
  // this too) and host-triggered session sharing to participants'
  // dashboards.
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteStatus, setInviteStatus] = useState("");
  // Invite section starts collapsed -- the ID/passcode/invite form take
  // up real estate that most people only need occasionally, so it's
  // tucked behind a dropdown toggle instead of always being open.
  const [inviteExpanded, setInviteExpanded] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareStatus, setShareStatus] = useState("");

  // Live cursors: { [username]: { path, from, to, color } }, populated
  // from cursor-move broadcasts. Only the entries matching activeFile are
  // ever shown — see the effect below that pushes them into CodeMirror.
  const [remoteCursors, setRemoteCursorsState] = useState({});

  const isRemoteUpdate = useRef(false);
  const toastTimer = useRef(null);
  const copiedTimer = useRef(null);
  const editorViewRef = useRef(null);
  const cursorThrottleRef = useRef({ lastSent: 0, timer: null, pending: null });

  const isHost = hasJoined && joinUsername === host;
  const canEdit = isHost || editors.includes(joinUsername);
  const canUseAI = isHost || aiEnabledForAll;
  const canRun = isHost || runEnabledForAll;
  const inviteLink = `${window.location.origin}/room/${roomId}?pwd=${passcode}`;
  const activeContent = activeFile ? files[activeFile] || "" : "";
  const detectedLanguage = detectLanguage(activeFile);

  useEffect(() => {
    if (!hasJoined) return;

    function joinRoom() {
      socket.emit("join-room", { roomId, username: joinUsername, passcode, token });
    }

    // Join immediately...
    joinRoom();

    // ...and re-join every time the socket (re)connects. Without this, a
    // brief network drop would silently leave the server thinking we're
    // still here after we've actually reconnected as a "new" connection —
    // we'd stop showing up in presence and stop receiving file updates.
    socket.on("connect", joinRoom);

    function handleFilesSync(newFiles) {
      isRemoteUpdate.current = true;
      setFiles(newFiles);
      setActiveFile((prev) => {
        if (prev && newFiles[prev] !== undefined) return prev;
        const firstFile = Object.keys(newFiles).find((p) => !p.endsWith("/"));
        return firstFile || null;
      });
    }

    function handleFileChange({ path, content }) {
      setFiles((prev) => ({ ...prev, [path]: content }));
      setActiveFile((current) => {
        if (path === current) isRemoteUpdate.current = true;
        return current;
      });
    }

    function handleUserList(list) {
      setUsers(list);
    }

    function handlePermissions({ host: newHost, editors: newEditors }) {
      setHost(newHost);
      setEditors(newEditors);
    }

    function handleAIAccess({ enabledForAll }) {
      setAiEnabledForAll(!!enabledForAll);
    }

    function handleAIResponse({ question, answer, error, kind }) {
      if (kind === "inputs") {
        setInputHintLoading(false);
        setInputHint({ answer, error });
        return;
      }
      setAiAsking(false);
      setAiHistory((prev) => [...prev, { question, answer, error }]);
    }

    function handleRunAccess({ enabledForAll }) {
      setRunEnabledForAll(!!enabledForAll);
    }

    function handleRunResult(data) {
      setRunning(false);
      if (data && data.error && data.stdout === undefined && data.stderr === undefined) {
        setResult({ error: data.error });
      } else {
        setResult(data);
      }
    }

    function handleJoinError(message) {
      // The passcode we tried turned out wrong, or the meeting doesn't
      // exist — bounce back to the join gate with an explanation instead
      // of silently sitting in a broken, empty "joined" room.
      setJoinError(message);
      setHasJoined(false);
    }

    function showToast(message) {
      setToast(message);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 3000);
    }

    function handleUserJoined(name) {
      showToast(`${name} joined`);
    }

    function handleUserLeft(name) {
      showToast(`${name} left`);
      setRemoteCursorsState((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }

    function handleCursorMove({ username, path, from, to }) {
      setRemoteCursorsState((prev) => ({
        ...prev,
        [username]: { path, from, to, color: colorForUsername(username) },
      }));
    }

    function handleChatHistory(history) {
      setChatMessages(Array.isArray(history) ? history : []);
    }

    function handleChatMessage(message) {
      setChatMessages((prev) => [...prev, message]);
    }

    function handleChatMessageEdited({ id, text, editedAt }) {
      setChatMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text, edited: true, editedAt } : m)));
    }

    function handleRoomMeta({ startedAt }) {
      if (typeof startedAt === "number") setRoomStartedAt(startedAt);
    }

    socket.on("files-sync", handleFilesSync);
    socket.on("file-change", handleFileChange);
    socket.on("user-list", handleUserList);
    socket.on("permissions", handlePermissions);
    socket.on("ai-access", handleAIAccess);
    socket.on("ai-help-response", handleAIResponse);
    socket.on("run-access", handleRunAccess);
    socket.on("run-result", handleRunResult);
    socket.on("join-error", handleJoinError);
    socket.on("user-joined", handleUserJoined);
    socket.on("user-left", handleUserLeft);
    socket.on("cursor-move", handleCursorMove);
    socket.on("chat-history", handleChatHistory);
    socket.on("chat-message", handleChatMessage);
    socket.on("chat-message-edited", handleChatMessageEdited);
    socket.on("room-meta", handleRoomMeta);

    return () => {
      socket.emit("leave-room");
      socket.off("connect", joinRoom);
      socket.off("files-sync", handleFilesSync);
      socket.off("file-change", handleFileChange);
      socket.off("user-list", handleUserList);
      socket.off("permissions", handlePermissions);
      socket.off("ai-access", handleAIAccess);
      socket.off("ai-help-response", handleAIResponse);
      socket.off("run-access", handleRunAccess);
      socket.off("run-result", handleRunResult);
      socket.off("join-error", handleJoinError);
      socket.off("user-joined", handleUserJoined);
      socket.off("user-left", handleUserLeft);
      socket.off("cursor-move", handleCursorMove);
      socket.off("chat-history", handleChatHistory);
      socket.off("chat-message", handleChatMessage);
      socket.off("chat-message-edited", handleChatMessageEdited);
      socket.off("room-meta", handleRoomMeta);
      clearTimeout(toastTimer.current);
    };
  }, [hasJoined, roomId, joinUsername, passcode, token]);

  // Auto-scrolls the chat thread to the newest message whenever one
  // arrives (or on first load, once history comes in).
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages]);

  // Drag-to-resize the editor's height: mousedown on the handle below
  // CodeMirror starts tracking, mousemove updates editorHeight (clamped to
  // a sane range), mouseup stops. Listeners are only attached to the
  // window while a drag is actually in progress, torn down immediately
  // after, so this doesn't cost anything the rest of the time.
  useEffect(() => {
    if (!isResizingEditor) return;

    function onMove(e) {
      const delta = e.clientY - resizeStartRef.current.y;
      setEditorHeight(Math.min(900, Math.max(200, resizeStartRef.current.height + delta)));
    }
    function onUp() {
      setIsResizingEditor(false);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizingEditor]);

  function startEditorResize(e) {
    resizeStartRef.current = { y: e.clientY, height: editorHeight };
    setIsResizingEditor(true);
  }

  // Session timer: ticks once a second off of roomStartedAt (see the
  // "room-meta" socket handler above). Purely local/derived — nothing
  // here is sent anywhere, it just recomputes "how long has this meeting
  // been running" from a timestamp the server already gave us.
  useEffect(() => {
    if (!roomStartedAt) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - roomStartedAt) / 1000)));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [roomStartedAt]);

  function formatElapsed(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // Keyboard shortcuts: Ctrl/Cmd+Enter runs the current file (same guard
  // as clicking Run — host-only unless the host opened it to everyone).
  // Ctrl/Cmd+S intercepts the browser's "Save Page" dialog, which is
  // almost never what anyone wants on a code editor, and downloads the
  // active file instead — the closest real equivalent to "save" this app
  // has, since edits are already synced live and there's no separate save
  // step.
  useEffect(() => {
    function handleKeyDown(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (detectedLanguage && canRun && !running) runCode();
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        if (activeFile) downloadActiveFile();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detectedLanguage, canRun, running, activeFile, activeContent]);

  // Pushes remote cursors for the CURRENTLY OPEN file into CodeMirror
  // whenever the cursor map or the open file changes — cursors on a file
  // you don't have open just sit in state, unrendered, until you switch
  // to that file.
  useEffect(() => {
    if (!editorViewRef.current) return;
    const cursorsForFile = Object.entries(remoteCursors)
      .filter(([, c]) => c.path === activeFile)
      .map(([username, c]) => ({ username, from: c.from, color: c.color }));
    editorViewRef.current.dispatch({ effects: setRemoteCursors.of(cursorsForFile) });
  }, [remoteCursors, activeFile]);

  function handleLocalChange(value) {
    if (isRemoteUpdate.current) {
      isRemoteUpdate.current = false;
      return;
    }

    // Defense in depth: CodeMirror's `editable={canEdit}` prop should
    // already prevent keystrokes from reaching here when the user isn't
    // allowed to edit, but the server is the real enforcement point (see
    // index.js's file-change handler) — a modified client could still
    // call this function directly, and the server will just ignore it.
    if (!canEdit || !activeFile) return;

    setFiles((prev) => ({ ...prev, [activeFile]: value }));
    socket.emit("file-change", { path: activeFile, content: value });
  }

  // Throttled cursor broadcast: sends immediately if enough time has
  // passed since the last send, otherwise queues the latest position and
  // sends it once the throttle window closes — so the last real position
  // always eventually goes out, not just whichever one happened to land
  // first in a burst of typing.
  function handleEditorUpdate(viewUpdate) {
    if (!viewUpdate.view) editorViewRef.current = viewUpdate.view;
    if (!viewUpdate.selectionSet || !activeFile) return;

    const { from, to } = viewUpdate.state.selection.main;
    const payload = { path: activeFile, from, to };
    const state = cursorThrottleRef.current;
    const now = Date.now();

    if (now - state.lastSent > 150) {
      socket.emit("cursor-move", payload);
      state.lastSent = now;
    } else {
      state.pending = payload;
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          if (state.pending) {
            socket.emit("cursor-move", state.pending);
            state.lastSent = Date.now();
            state.pending = null;
          }
        }, 150);
      }
    }
  }

  function handleJoinSubmit(e) {
    e.preventDefault();
    if (!user && !guestName.trim()) return;
    if (!passcode.trim()) {
      setJoinError("Enter the meeting passcode.");
      return;
    }
    setJoinError("");
    setHasJoined(true);
  }

  function copyToClipboard(text, label) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(""), 1500);
    });
  }

  function leaveRoom() {
    navigate("/");
  }

  // Logging out from inside a room: clears the account session (same
  // logout() the Dashboard uses) and leaves the meeting the same way
  // leaveRoom() does above -- navigating away unmounts Room.jsx, whose
  // main effect's cleanup already emits "leave-room" on unmount, so
  // there's nothing extra to do here beyond those two calls. Only shown
  // to logged-in users (see the icon rail below) -- guests have no
  // account to log out of.
  function logoutFromRoom() {
    logout();
    navigate("/");
  }

  function toggleUserAccess(name, nextCanEdit) {
    socket.emit("set-permission", { username: name, canEdit: nextCanEdit });
  }

  function toggleAIAccess(enabledForAll) {
    socket.emit("set-ai-access", { enabledForAll });
  }

  function askAI(e) {
    e.preventDefault();
    if (!aiQuestion.trim() || !canUseAI) return;
    setAiAsking(true);
    socket.emit("ai-help", { question: aiQuestion.trim(), code: activeContent, language: detectedLanguage });
    setAiQuestion("");
  }

  // Runs through the same permission-checked ai-help socket flow as Ask
  // AI, just with a fixed question and a "inputs" kind tag so the answer
  // comes back to inputHint instead of the Ask AI chat thread.
  function analyzeInputs() {
    if (!canUseAI || !activeContent?.trim()) return;
    setInputHintLoading(true);
    setInputHint(null);
    socket.emit("ai-help", {
      kind: "inputs",
      code: activeContent,
      language: detectedLanguage,
      question:
        "List exactly what stdin input this program reads, in the exact order it will read it. " +
        "For each one give a short label and its type/format (e.g. '1. integer n', '2. n integers, one per line'). " +
        "Only output the numbered list, nothing else -- no explanation of the code.",
    });
  }

  function sendChatMessage(e) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    socket.emit("send-chat-message", { text: chatInput.trim() });
    setChatInput("");
  }

  function startEditingMessage(message) {
    setEditingMessageId(message.id);
    setEditingText(message.text);
  }

  function cancelEditingMessage() {
    setEditingMessageId(null);
    setEditingText("");
  }

  function saveEditedMessage(e) {
    e.preventDefault();
    if (!editingText.trim() || !editingMessageId) return;
    socket.emit("edit-chat-message", { id: editingMessageId, text: editingText.trim() });
    setEditingMessageId(null);
    setEditingText("");
  }

  function formatChatTime(timestamp) {
    if (!timestamp) return "";
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function openFile(path) {
    setActiveFile(path);
  }

  function createFile(path, content) {
    socket.emit("create-file", { path, content });
  }

  function createFolder(path) {
    socket.emit("create-folder", { path });
  }

  function deleteEntry(path, isFolder) {
    socket.emit("delete-entry", { path, isFolder });
  }

  // Run is host-only by default (see canRun) and enforced server-side over
  // the socket connection, not via a plain REST call -- see index.js's
  // run-code handler and its comment for why this moved off REST
  // entirely. The result comes back asynchronously via the "run-result"
  // listener registered in the main effect above (handleRunResult).
  function runCode() {
    if (!detectedLanguage || !canRun) return;
    setActivePanelTab("console");
    setRunning(true);
    setResult(null);
    socket.emit("run-code", { language: detectedLanguage, code: activeContent, stdin: stdinValue });
  }

  function toggleRunAccess(enabledForAll) {
    socket.emit("set-run-access", { enabledForAll });
  }

  function copyActiveCode() {
    if (!activeContent) return;
    copyToClipboard(activeContent, "code");
  }

  // Downloads just the currently open file (as opposed to downloadZip
  // below, which packages the whole room). Purely client-side — the
  // content's already sitting in `files` state, no round trip needed.
  function downloadActiveFile() {
    if (!activeFile) return;
    const blob = new Blob([activeContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = activeFile.split("/").pop() || "file.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function sendInvite(e) {
    e.preventDefault();
    if (!user || !inviteUsername.trim()) return;
    setInviteStatus("");
    try {
      const res = await authFetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toUsername: inviteUsername.trim(), roomId, passcode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send invite.");
      setInviteStatus(`Invited ${inviteUsername.trim()}.`);
      setInviteUsername("");
    } catch (err) {
      setInviteStatus(err.message);
    }
  }

  async function shareSession() {
    setSharing(true);
    setShareStatus("");
    try {
      const res = await authFetch(`/api/sessions/${roomId}/share`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not share session.");
      setShareStatus(`Saved to ${data.sharedWith} dashboard${data.sharedWith === 1 ? "" : "s"}.`);
    } catch (err) {
      setShareStatus(err.message);
    } finally {
      setSharing(false);
    }
  }

  async function downloadZip() {
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/download?passcode=${passcode}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showDownloadError(data.error || "Could not download this meeting's files.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${roomId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showDownloadError("Could not reach the server. Is it running?");
    }
  }

  function showDownloadError(message) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  if (!hasJoined) {
    return (
      <div className="join-gate">
        <div className="join-gate-card">
          <div className="join-gate-logo">⌨️</div>
          <h1>Join meeting {roomId}</h1>
          {joinError && <div className="join-error">{joinError}</div>}
          <form onSubmit={handleJoinSubmit}>
            {user ? (
              <div className="joining-as">
                Joining as <strong>{user.username}</strong>
              </div>
            ) : (
              <input
                autoFocus
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Your name"
              />
            )}
            {!urlPasscode && (
              <input
                value={manualPasscode}
                onChange={(e) => setManualPasscode(e.target.value)}
                placeholder="Passcode"
              />
            )}
            <button type="submit">Join</button>
          </form>
          {!user && (
            <p className="join-gate-hint">
              <Link to="/login">Log in</Link> to join as yourself and unlock invites, saved sessions, and teams.
            </p>
          )}
        </div>
      </div>
    );
  }

  const editorExtensions = [
    EDITOR_EXTENSIONS[detectedLanguage] || javascript(),
    remoteCursorsExtension,
    EditorView.theme({ "&": { fontSize: `${fontSize}px` } }),
  ];
  if (minimapEnabled) editorExtensions.push(buildMinimapExtension());

  return (
    <div className="room-shell">
      {/* Icon rail — every icon here does something real; nothing purely
          decorative made it in. */}
      <nav className="icon-rail">
        <div className="icon-rail-logo">⌨️</div>

        {/* Chat, Team, and Invite used to have their own buttons here too,
            but they just scrolled to / selected a tab in the Team panel on
            the right, which already has its own Chat/Team tabs and a full
            Invite section -- pure duplication. Removed; Files and ZIP stay
            because they aren't available anywhere else on this page. */}
        <button
          className="icon-rail-button"
          onClick={() => document.getElementById("file-tree-panel")?.scrollIntoView({ behavior: "smooth" })}
          title="Files"
        >
          <span className="icon-rail-icon">📁</span>
          <span className="icon-rail-label">Files</span>
        </button>
        <button className="icon-rail-button" onClick={downloadZip} title="Download files as ZIP">
          <span className="icon-rail-icon">📦</span>
          <span className="icon-rail-label">ZIP</span>
        </button>
        <div className="icon-rail-spacer" />
        {/* Labeled (and named) "Dashboard", not "Home" -- it goes to
            /dashboard, not the landing page, so the label should say what
            it actually does. Carries the current room's id+passcode as
            router state so the Dashboard can offer a real way back into
            THIS meeting instead of stranding you on a page with no path
            back except re-typing the meeting ID and passcode from
            scratch -- see Dashboard.jsx's "Return to meeting" banner. */}
        <Link
          to="/dashboard"
          state={{ fromRoom: { roomId, passcode } }}
          className="icon-rail-button"
          title="Dashboard"
        >
          <span className="icon-rail-icon">📊</span>
          <span className="icon-rail-label">Dashboard</span>
        </Link>
        {user && (
          <button className="icon-rail-button" onClick={logoutFromRoom} title={`Log out (${user.username})`}>
            <span className="icon-rail-icon">🔓</span>
            <span className="icon-rail-label">Log out</span>
          </button>
        )}
        <button className="icon-rail-button danger" onClick={leaveRoom} title="Leave meeting">
          <span className="icon-rail-icon">🚪</span>
          <span className="icon-rail-label">Leave</span>
        </button>
      </nav>

      <div className="room">
        <header className="room-header">
          <div className="room-header-left">
            <div className="room-title">
              <div className="room-title-icon">⌨️</div>
              <h1>Room</h1>
              <span className="room-id-badge">{roomId}</span>
              {roomStartedAt && (
                <span className="session-timer" title="Time since this meeting started">
                  ⏱ {formatElapsed(elapsedSeconds)}
                </span>
              )}
            </div>
          </div>
          <div className="room-header-right">
            <div className="user-list">
              {users.map((name, i) => (
                <span className={`user-pill ${name === host ? "user-pill-host" : ""}`} key={`${name}-${i}`}>
                  <span className="user-pill-dot" />
                  {name}
                  {name === host && " 👑"}
                </span>
              ))}
            </div>
            {/* Account identity, moved here from the icon rail -- top-right
                is where every other page in the app (Dashboard's topbar)
                shows who's logged in, so Room.jsx should match instead of
                burying it in the sidebar. Guests (no account) don't get
                this -- there's nothing to show. */}
            {user && (
              <div className="room-header-account" title={`Logged in as ${user.username}`}>
                <div className="room-header-avatar">{user.username.slice(0, 1).toUpperCase()}</div>
                <span className="room-header-username">{user.username}</span>
              </div>
            )}
          </div>
        </header>

        {toast && <div className="toast">{toast}</div>}

        {!canEdit && (
          <div className="readonly-banner">
            View only — ask {host || "the host"} to grant you write access.
          </div>
        )}

        <div className="workspace">
          <div id="file-tree-panel">
            <FileTree
              files={files}
              activeFile={activeFile}
              canEdit={canEdit}
              onOpenFile={openFile}
              onCreateFile={createFile}
              onCreateFolder={createFolder}
              onDelete={deleteEntry}
            />
          </div>

          <div className="editor-column">
            <div className="editor-toolbar-top">
              <h2 className="editor-panel-title">Editor</h2>
              <div className="editor-toolbar-icons">
                <button
                  className="editor-icon-btn editor-icon-btn-primary"
                  onClick={runCode}
                  disabled={running || !detectedLanguage || !canRun}
                  title={canRun ? "Run code (Ctrl+Enter)" : `Running is host-only — ask ${host || "the host"} to turn it on`}
                >
                  ⚡
                </button>
                <button className="editor-icon-btn" onClick={() => setActivePanelTab("ai")} title="Ask AI">
                  ✦
                </button>
                <button className="editor-icon-btn" onClick={copyActiveCode} disabled={!activeContent} title="Copy code">
                  {copied === "code" ? "✓" : "⧉"}
                </button>
                <button className="editor-icon-btn" onClick={downloadActiveFile} disabled={!activeFile} title="Download this file (Ctrl+S)">
                  ⇩
                </button>
                <button className="editor-icon-btn" onClick={() => setResult(null)} disabled={!result} title="Clear output">
                  ↺
                </button>
              </div>
            </div>

            <div className="toolbar">
              <div className="toolbar-left">
                <span className="active-file-label">
                  {activeFile ? `📄 ${activeFile}` : "No file open"}
                </span>
                {!detectedLanguage && activeFile && (
                  <span className="unsupported-note">
                    ⚠ Unsupported — rename with .js .py .cpp .c .java to run
                  </span>
                )}
                {detectedLanguage && !canRun && (
                  <span className="unsupported-note">
                    Running is host-only — ask {host || "the host"} to turn it on for everyone.
                  </span>
                )}
              </div>
              {running && <span className="unsupported-note">Running…</span>}
            </div>

            {/* Editor display settings — genuinely wired in, not
                decorative: lineNumbers flows into CodeMirror's basicSetup,
                fontSize drives a live theme extension, minimap
                conditionally includes @replit/codemirror-minimap. */}
            <div className="editor-settings-row">
              <label className="editor-setting-checkbox">
                <input
                  type="checkbox"
                  checked={minimapEnabled}
                  onChange={(e) => setMinimapEnabled(e.target.checked)}
                />
                Minimap
              </label>
              <label className="editor-setting-checkbox">
                <input
                  type="checkbox"
                  checked={lineNumbersEnabled}
                  onChange={(e) => setLineNumbersEnabled(e.target.checked)}
                />
                Line Numbers
              </label>
              <label className="editor-setting-fontsize">
                Font Size
                <input
                  type="number"
                  min={10}
                  max={24}
                  value={fontSize}
                  onChange={(e) => setFontSize(Math.min(24, Math.max(10, Number(e.target.value) || 14)))}
                />
              </label>
            </div>

            {/* Remounts on every file switch (key={activeFile}) instead of
                relying on CodeMirror's value-prop diffing to swap content —
                switching between files with different content AND different
                language extensions in the same instance was the root cause
                of participants not seeing each other's edits after a file
                switch: the editor could get stuck showing stale/empty
                content even though the underlying synced state was already
                correct. */}
            <CodeMirror
              key={activeFile}
              value={activeContent}
              height={`${editorHeight}px`}
              extensions={editorExtensions}
              basicSetup={{ lineNumbers: lineNumbersEnabled }}
              onChange={handleLocalChange}
              onUpdate={handleEditorUpdate}
              onCreateEditor={(view) => {
                editorViewRef.current = view;
              }}
              editable={canEdit}
              theme={theme === "light" ? "light" : "dark"}
            />

            {/* Drag-to-resize handle — mousedown here kicks off the
                isResizingEditor effect above, which tracks mousemove until
                mouseup. Dragging (rather than scrolling) is the standard
                pattern for resizing a fixed panel: scroll-to-resize would
                fight with the editor's own internal scrolling the moment
                your content doesn't fit in one screen. */}
            <div
              className="editor-resize-handle"
              onMouseDown={startEditorResize}
              title="Drag to resize the editor"
            >
              <span className="editor-resize-grip" />
            </div>

            <div className="panel-tabs">
              <button
                className={`panel-tab ${activePanelTab === "console" ? "panel-tab-active" : ""}`}
                onClick={() => setActivePanelTab("console")}
              >
                <span className="output-dot" /> Console
              </button>
              <button
                className={`panel-tab ${activePanelTab === "ai" ? "panel-tab-active" : ""}`}
                onClick={() => setActivePanelTab("ai")}
                id="ai-panel"
              >
                <span className="ai-panel-icon">✦</span> Ask AI
              </button>
            </div>

            {activePanelTab === "console" && (
              <>
                {/* Stdin box: if the program reads input, it needs
                    something to read or it just runs to completion
                    silently — that looks identical to "not executing" but
                    is expected behavior. */}
                <div className="output-panel">
                  <div className="output-header">
                    <div className="output-dot" style={{ background: "var(--accent-glow)" }} />
                    <span className="output-label">Input (stdin)</span>
                    {canUseAI && (
                      <button
                        type="button"
                        className="input-hint-btn"
                        onClick={analyzeInputs}
                        disabled={inputHintLoading || !activeContent?.trim()}
                        title="Ask AI to list exactly what input this code expects, in order"
                      >
                        {inputHintLoading ? "Analyzing…" : "🔍 What input is needed?"}
                      </button>
                    )}
                  </div>
                  <div className="output-body" style={{ paddingTop: 10 }}>
                    {inputHint && (
                      <div className={`input-hint ${inputHint.error ? "input-hint-error" : ""}`}>
                        {inputHint.error || inputHint.answer}
                      </div>
                    )}
                    <textarea
                      className="stdin-textarea"
                      placeholder="If your program reads input, type it here — one value per line."
                      value={stdinValue}
                      onChange={(e) => setStdinValue(e.target.value)}
                      rows={3}
                    />
                  </div>
                </div>

                <div className="output-panel">
                  <div className="output-header">
                    <div className="output-dot" />
                    <span className="output-label">Execution Console</span>
                  </div>
                  <div className="output-body">
                    {!result && !running && (
                      <div className="output-empty">Run your code to see output here.</div>
                    )}
                    {running && <div className="output-empty">⏳ Running…</div>}
                    {result?.error && <pre className="output-stderr">{result.error}</pre>}
                    {result && !result.error && (
                      <>
                        {result.stdout && <pre className="output-stdout">{result.stdout}</pre>}
                        {result.stderr && <pre className="output-stderr">{result.stderr}</pre>}
                        {!result.stdout && !result.stderr && (
                          <div className="output-empty">Program produced no output.</div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </>
            )}

            {activePanelTab === "ai" &&
              (canUseAI ? (
                <div className="ai-panel">
                  <div className="ai-panel-header">
                    <span className="ai-panel-icon">✦</span>
                    <span className="ai-panel-title">Ask AI for help</span>
                  </div>
                  <div className="ai-panel-body">
                    {aiHistory.length === 0 && !aiAsking && (
                      <div className="output-empty" style={{ marginBottom: 12 }}>
                        Stuck on something? Ask a question about your code.
                      </div>
                    )}
                    <div className="ai-history">
                      {aiHistory.map((entry, i) => (
                        <div className="ai-entry" key={i}>
                          <div className="ai-question">{entry.question}</div>
                          {entry.error ? (
                            <pre className="output-stderr">{entry.error}</pre>
                          ) : (
                            <pre className="ai-answer">{entry.answer}</pre>
                          )}
                        </div>
                      ))}
                      {aiAsking && <div className="output-empty">Thinking…</div>}
                    </div>
                    <form className="ai-form" onSubmit={askAI}>
                      <input
                        value={aiQuestion}
                        onChange={(e) => setAiQuestion(e.target.value)}
                        placeholder="e.g. why is my loop off by one?"
                        disabled={aiAsking}
                      />
                      <button type="submit" disabled={aiAsking || !aiQuestion.trim()}>
                        Ask
                      </button>
                    </form>
                  </div>
                </div>
              ) : (
                <div className="readonly-banner" style={{ marginTop: 10, marginBottom: 0 }}>
                  Ask AI is host-only right now — ask {host || "the host"} to turn it on for everyone.
                </div>
              ))}
          </div>

          <aside className="team-panel" id="team-panel">
            <div className="team-panel-header">
              <span className="team-panel-eyebrow">Project Room</span>
              <h2>Team</h2>
            </div>

            <div className="team-panel-meta">
              <span className="team-panel-meta-icon">👥</span>
              <div>
                <div className="team-panel-count">
                  {users.length} member{users.length === 1 ? "" : "s"}
                </div>
                <div className="team-panel-status">
                  <span className="status-dot" /> active
                </div>
              </div>
            </div>

            <div className="team-member-list">
              {users.map((name, i) => (
                <div className="team-member" key={`${name}-${i}`}>
                  <span className="team-member-avatar" style={{ background: colorForUsername(name) }}>
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="team-member-name">{name}</span>
                  {name === host ? (
                    <span className="badge-violet team-member-badge">Host</span>
                  ) : editors.includes(name) ? (
                    <span className="badge-cyan team-member-badge">Editor</span>
                  ) : (
                    <span className="team-member-badge team-member-badge-viewer">Viewer</span>
                  )}
                </div>
              ))}
            </div>

            <div className="team-panel-tabs">
              <button
                className={`team-panel-tab ${rightPanelTab === "chat" ? "team-panel-tab-active" : ""}`}
                onClick={() => setRightPanelTab("chat")}
              >
                💬 Chat
              </button>
              <button
                className={`team-panel-tab ${rightPanelTab === "team" ? "team-panel-tab-active" : ""}`}
                onClick={() => setRightPanelTab("team")}
              >
                👥 Team
              </button>
            </div>

            {rightPanelTab === "chat" && (
              <div className="chat-panel">
                <div className="chat-thread">
                  {chatMessages.length === 0 && (
                    <div className="chat-empty">Start the conversation.</div>
                  )}
                  {chatMessages.map((m, i) => {
                    const isOwn = m.username === joinUsername;
                    const isEditing = editingMessageId === m.id;
                    return (
                      <div className={`chat-message ${isOwn ? "chat-message-own" : ""}`} key={m.id || i}>
                        <div className="chat-message-meta">
                          <span className="chat-message-author" style={{ color: colorForUsername(m.username) }}>
                            {m.username}
                          </span>
                          <span className="chat-message-meta-right">
                            <span className="chat-message-time">
                              {formatChatTime(m.timestamp)}
                              {m.edited && " · edited"}
                            </span>
                            {isOwn && m.id && !isEditing && (
                              <button
                                className="chat-message-edit-btn"
                                onClick={() => startEditingMessage(m)}
                                title="Edit message"
                              >
                                ✎
                              </button>
                            )}
                          </span>
                        </div>
                        {isEditing ? (
                          <form className="chat-message-edit-form" onSubmit={saveEditedMessage}>
                            <input
                              autoFocus
                              value={editingText}
                              onChange={(e) => setEditingText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") cancelEditingMessage();
                              }}
                              maxLength={2000}
                            />
                            <button type="submit" disabled={!editingText.trim()}>
                              Save
                            </button>
                            <button type="button" onClick={cancelEditingMessage}>
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <div className="chat-message-text">{m.text}</div>
                        )}
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
                <form className="chat-composer" onSubmit={sendChatMessage}>
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Message the room…"
                    maxLength={2000}
                  />
                  <button type="submit" disabled={!chatInput.trim()}>
                    Send
                  </button>
                </form>
              </div>
            )}

            {rightPanelTab === "team" && (
              <>
                <div className="team-panel-section">
                  <button
                    type="button"
                    className="team-panel-section-title team-panel-section-toggle"
                    onClick={() => setInviteExpanded((v) => !v)}
                    aria-expanded={inviteExpanded}
                  >
                    Invite
                    <span className={`team-panel-section-caret ${inviteExpanded ? "open" : ""}`}>▸</span>
                  </button>
                  {inviteExpanded && (
                    <>
                      <div className="invite-row">
                        <span className="invite-field">
                          ID: <strong>{roomId}</strong>
                        </span>
                        <span className="invite-field">
                          Passcode: <strong>{passcode}</strong>
                        </span>
                      </div>
                      <div className="invite-row">
                        <button onClick={() => copyToClipboard(inviteLink, "link")}>
                          {copied === "link" ? "Copied!" : "Copy Invite Link"}
                        </button>
                        <button onClick={() => copyToClipboard(roomId, "id")}>
                          {copied === "id" ? "Copied!" : "Copy ID"}
                        </button>
                      </div>
                      {user ? (
                        <form className="invite-by-username" onSubmit={sendInvite}>
                          <input
                            value={inviteUsername}
                            onChange={(e) => setInviteUsername(e.target.value)}
                            placeholder="Invite by username"
                          />
                          <button type="submit">Send</button>
                        </form>
                      ) : (
                        <div className="invite-status">
                          <Link to="/login">Log in</Link> to invite registered users directly.
                        </div>
                      )}
                      {inviteStatus && <div className="invite-status">{inviteStatus}</div>}
                    </>
                  )}
                </div>

                {isHost && (
                  <div className="team-panel-section">
                    <div className="team-panel-section-title">Host controls</div>
                    <div className="permissions-list">
                      {users
                        .filter((name) => name !== joinUsername)
                        .map((name, i) => {
                          const allowed = editors.includes(name);
                          return (
                            <label className="permissions-item" key={`${name}-${i}`}>
                              <input
                                type="checkbox"
                                checked={allowed}
                                onChange={(e) => toggleUserAccess(name, e.target.checked)}
                              />
                              {name} can edit
                            </label>
                          );
                        })}
                      {users.length <= 1 && <span className="permissions-empty">No one else here yet.</span>}
                    </div>
                    <label className="permissions-item ai-toggle">
                      <input
                        type="checkbox"
                        checked={aiEnabledForAll}
                        onChange={(e) => toggleAIAccess(e.target.checked)}
                      />
                      Let everyone use Ask AI
                    </label>
                    <label className="permissions-item ai-toggle" style={{ marginTop: 8, paddingTop: 0, borderTop: "none" }}>
                      <input
                        type="checkbox"
                        checked={runEnabledForAll}
                        onChange={(e) => toggleRunAccess(e.target.checked)}
                      />
                      Let everyone run code
                    </label>
                    {user && (
                      <div className="share-session-row">
                        <button onClick={shareSession} disabled={sharing}>
                          {sharing ? "Saving…" : "Save session to everyone's dashboard"}
                        </button>
                        {shareStatus && <span className="share-status">{shareStatus}</span>}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

export default Room;
