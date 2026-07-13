import { useMemo, useState } from "react";
import { buildFileTree, sortedEntries, starterContentFor } from "./fileUtils";

// The sidebar file explorer. Presentational — all the actual state (which
// files exist, which one's open) lives in Room.jsx; this component just
// renders the tree and calls back up. Folder collapse/expand state is the
// one thing that's genuinely local to the tree itself, so it lives here.
//
// Creating a file/folder uses a plain window.prompt() for the path rather
// than an inline rename-style text input — a deliberate scope cut to keep
// this from turning into its own small text-editing subsystem.
function FileTree({ files, activeFile, canEdit, onOpenFile, onCreateFile, onCreateFolder, onDelete }) {
  const [collapsed, setCollapsed] = useState({});
  const [search, setSearch] = useState("");

  const tree = buildFileTree(files);

  // Find in files: matches by filename OR by file content, case
  // insensitive. Folders always show if anything inside them matches (so
  // you don't lose the path to a hit), even if the folder's own name
  // doesn't match the query.
  const matchingPaths = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const matches = new Set();
    for (const [path, content] of Object.entries(files)) {
      if (path.endsWith("/")) continue;
      const nameMatch = path.toLowerCase().includes(q);
      const contentMatch = typeof content === "string" && content.toLowerCase().includes(q);
      if (nameMatch || contentMatch) {
        matches.add(path);
        // Also mark every ancestor folder so it stays visible/expanded.
        const segments = path.split("/");
        for (let i = 1; i < segments.length; i++) {
          matches.add(segments.slice(0, i).join("/") + "/");
        }
      }
    }
    return matches;
  }, [files, search]);

  function toggleCollapse(path) {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));
  }

  function handleCreateFile() {
    const path = window.prompt("New file path (e.g. src/app.js):");
    if (path && path.trim()) onCreateFile(path.trim(), starterContentFor(path.trim()));
  }

  function handleCreateFolder() {
    const path = window.prompt("New folder path (e.g. src/utils):");
    if (path && path.trim()) onCreateFolder(path.trim());
  }

  function handleDelete(e, path, isFolder) {
    e.stopPropagation();
    const label = isFolder ? `folder "${path}" and everything in it` : `file "${path}"`;
    if (window.confirm(`Delete ${label}?`)) onDelete(path, isFolder);
  }

  function renderNode(node, depth) {
    return sortedEntries(node)
      .filter((entry) => !matchingPaths || matchingPaths.has(entry.path))
      .map((entry) => {
        if (entry.type === "folder") {
          // While searching, force every visible folder open — collapsed
          // state would otherwise hide the very match we just filtered in.
          const isCollapsed = matchingPaths ? false : !!collapsed[entry.path];
          return (
            <div key={entry.path}>
              <div
                className="tree-row tree-folder"
                style={{ paddingLeft: 10 + depth * 14 }}
                onClick={() => toggleCollapse(entry.path)}
              >
                <span className="tree-icon">{isCollapsed ? "▸" : "▾"}</span>
                <span className="tree-name">{entry.name}</span>
                {canEdit && (
                  <button
                    className="tree-delete"
                    onClick={(e) => handleDelete(e, entry.path, true)}
                    title="Delete folder"
                  >
                    ✕
                  </button>
                )}
              </div>
              {!isCollapsed && renderNode(entry, depth + 1)}
            </div>
          );
        }
        return (
          <div
            key={entry.path}
            className={`tree-row tree-file ${entry.path === activeFile ? "tree-file-active" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => onOpenFile(entry.path)}
          >
            <span className="tree-icon" style={{ fontSize: "11px" }}>📄</span>
            <span className="tree-name">{entry.name}</span>
            {canEdit && (
              <button
                className="tree-delete"
                onClick={(e) => handleDelete(e, entry.path, false)}
                title="Delete file"
              >
                ✕
              </button>
            )}
          </div>
        );
      });
  }

  const hasAnyFile = Object.keys(files).some((p) => !p.endsWith("/"));

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span className="file-tree-label">Files</span>
        {canEdit && (
          <div className="file-tree-actions">
            <button onClick={handleCreateFile} title="New file">+ file</button>
            <button onClick={handleCreateFolder} title="New folder">+ folder</button>
          </div>
        )}
      </div>
      {hasAnyFile && (
        <div className="file-tree-search">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find in files…"
          />
          {search && (
            <button className="file-tree-search-clear" onClick={() => setSearch("")} title="Clear search">
              ✕
            </button>
          )}
        </div>
      )}
      <div className="file-tree-body">
        {!hasAnyFile ? (
          <div className="file-tree-empty">
            No files yet.
            {canEdit ? " Click “+ file” to create one." : " Waiting for the host to add one."}
          </div>
        ) : matchingPaths && matchingPaths.size === 0 ? (
          <div className="file-tree-empty">No files match "{search}".</div>
        ) : (
          renderNode(tree, 0)
        )}
      </div>
    </div>
  );
}

export default FileTree;
