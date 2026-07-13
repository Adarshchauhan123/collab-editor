// Small, framework-free helpers shared between Room.jsx and FileTree.jsx
// for working with the room's flat file map (path -> content, where a
// path ending in "/" is a folder marker). Kept separate so the "how do we
// turn a flat path list into a tree" logic isn't buried inside a
// component file.

// Maps a file extension to the language key /api/execute and CodeMirror's
// syntax highlighting both understand. Multi-file mode auto-detects the
// language from whichever file is open instead of a manual dropdown — one
// less thing to keep in sync with what's actually in the file.
const EXTENSION_LANGUAGE = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  cpp: "c++",
  cc: "c++",
  cxx: "c++",
  hpp: "c++",
  h: "c++",
  c: "c",
  java: "java",
};

export function detectLanguage(path) {
  if (!path) return null;
  const ext = path.split(".").pop().toLowerCase();
  return EXTENSION_LANGUAGE[ext] || null;
}

// Starter content for a brand-new file, keyed by the same language key
// detectLanguage returns. Rooms no longer auto-create a "main.js" (see
// db.js's DEFAULT_FILES) -- instead, whatever file the user actually
// creates gets a small, honest "hello world"-style snippet appropriate to
// its extension, computed here on the client and sent along with
// create-file so the server doesn't need its own copy of this mapping.
// Unrecognized extensions just get an empty file, same as before this
// feature existed.
const STARTER_TEMPLATES = {
  javascript: 'console.log("Hello, world!");\n',
  python: 'print("Hello, world!")\n',
  "c++": '#include <iostream>\n\nint main() {\n    std::cout << "Hello, world!" << std::endl;\n    return 0;\n}\n',
  c: '#include <stdio.h>\n\nint main() {\n    printf("Hello, world!\\n");\n    return 0;\n}\n',
  // The class is named "prog", not "Main" -- Wandbox (the free compiler
  // this app runs code through) always saves the submitted source as a
  // fixed file called prog.java and runs it as `java prog`, regardless of
  // filename in this editor. javac requires a PUBLIC class to match its
  // file's name exactly, so "public class Main" fails to compile there
  // with "class Main is public, should be declared in a file named
  // Main.java" -- which showed up in the app as a confusing "no output"
  // rather than a clear error (see index.js's executeCode for the other
  // half of this fix). "prog" matches Wandbox's own official template, so
  // it's guaranteed to work.
  java: 'public class prog {\n    public static void main(String[] args) {\n        System.out.println("Hello, world!");\n    }\n}\n',
};

export function starterContentFor(path) {
  const language = detectLanguage(path);
  return STARTER_TEMPLATES[language] || "";
}

// Turns a flat { "src/utils/helper.js": "...", "assets/": "" } map into a
// nested tree for rendering. Intermediate folders are synthesized even
// without an explicit folder marker (creating "src/a.js" alone still
// shows a "src" folder) — explicit folder markers (paths ending in "/")
// only matter for folders that are otherwise completely empty.
export function buildFileTree(files) {
  const root = { type: "folder", name: "", path: "", children: {} };

  for (const rawPath of Object.keys(files)) {
    const isFolder = rawPath.endsWith("/");
    const clean = isFolder ? rawPath.slice(0, -1) : rawPath;
    if (!clean) continue;
    const segments = clean.split("/");
    let node = root;

    segments.forEach((seg, i) => {
      const isLastSegment = i === segments.length - 1;
      if (isLastSegment && !isFolder) {
        node.children[`file:${seg}`] = { type: "file", name: seg, path: clean };
        return;
      }
      const key = `folder:${seg}`;
      if (!node.children[key]) {
        node.children[key] = {
          type: "folder",
          name: seg,
          path: segments.slice(0, i + 1).join("/") + "/",
          children: {},
        };
      }
      node = node.children[key];
    });
  }

  return root;
}

// Folders first (alphabetical), then files (alphabetical) — standard file
// explorer ordering.
export function sortedEntries(node) {
  return Object.values(node.children).sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// A small, stable set of readable colors, picked deterministically from a
// username (same person always gets the same color, including across
// reconnects) via a simple string hash — no coordination with the server
// needed for this, it's purely a client-side cosmetic choice.
const CURSOR_COLORS = ["#f28b82", "#fbbc04", "#81c995", "#78d9ec", "#8ab4f8", "#c58af9", "#ff8bcb", "#f6ad55"];

export function colorForUsername(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}
