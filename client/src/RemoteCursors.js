// A small CodeMirror 6 extension that renders OTHER people's cursor
// positions as colored carets with a floating name label — the "live
// cursor" feature. This is a manual, from-scratch relay over our own
// Socket.io connection (see Room.jsx's cursor-move handling), not a CRDT
// awareness protocol like Yjs's — consistent with the rest of this app's
// broadcast-sync model (see README's Design decisions on why sync here is
// broadcast-based, not CRDT-based).
//
// Standard CM6 pattern: a StateEffect carries the latest cursor list into
// the editor, a StateField turns that into widget decorations, and
// `EditorView.decorations.from(field)` wires it into rendering. The
// widget itself is just a zero-width styled <span> (a fake caret) with a
// small absolutely-positioned label above it — see Room.css's
// .remote-cursor / .remote-cursor-label rules for the actual look.
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

export const setRemoteCursors = StateEffect.define();

class RemoteCursorWidget extends WidgetType {
  constructor(username, color) {
    super();
    this.username = username;
    this.color = color;
  }

  eq(other) {
    return other.username === this.username && other.color === this.color;
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "remote-cursor";
    wrap.style.borderLeftColor = this.color;

    const label = document.createElement("span");
    label.className = "remote-cursor-label";
    label.textContent = this.username;
    label.style.background = this.color;
    wrap.appendChild(label);

    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

const remoteCursorsField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCursors)) {
        const docLength = tr.state.doc.length;
        const built = effect.value.map((cursor) => {
          const pos = Math.max(0, Math.min(cursor.from, docLength));
          return Decoration.widget({
            widget: new RemoteCursorWidget(cursor.username, cursor.color),
            side: 1,
          }).range(pos);
        });
        // Widgets must be sorted by position for Decoration.set.
        built.sort((a, b) => a.from - b.from);
        decorations = Decoration.set(built);
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// The full extension to hand to CodeMirror's `extensions` array.
export const remoteCursorsExtension = [remoteCursorsField];
