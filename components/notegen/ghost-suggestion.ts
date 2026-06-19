import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type Rewrite = { from: string; to: string };

const sugKey = new PluginKey<{ text: string | null }>("ghostSuggestion");
const rwKey = new PluginKey<{ list: Rewrite[] }>("rewriteSuggestion");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    ghostSuggestion: {
      setSuggestion: (text: string) => ReturnType;
      clearSuggestion: () => ReturnType;
      acceptSuggestion: () => ReturnType;
      setRewrites: (list: Rewrite[]) => ReturnType;
      clearRewrites: () => ReturnType;
      acceptRewrite: (from: string, to: string) => ReturnType;
    };
  }
}

/**
 * Inline assist decorations (R3 ghost completions + R4 rewrites).
 * - Ghost: grey suggestion at the cursor; Tab accepts, typing/Esc clears.
 * - Rewrites: dotted-underline over each shorthand span; accept replaces the span.
 * Both clear on typing and are re-set from the /analyze response.
 */
export const GhostSuggestion = Extension.create({
  name: "ghostSuggestion",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: sugKey,
        state: {
          init: () => ({ text: null as string | null }),
          apply(tr, value) {
            const meta = tr.getMeta(sugKey);
            if (meta !== undefined) return { text: meta as string | null };
            if (tr.docChanged || tr.selectionSet) return { text: null };
            return value;
          },
        },
        props: {
          decorations(state) {
            const s = sugKey.getState(state);
            if (!s?.text) return null;
            const widget = Decoration.widget(
              state.selection.head,
              () => { const el = document.createElement("span"); el.className = "mng-ghost"; el.textContent = s.text as string; return el; },
              { side: 1 },
            );
            return DecorationSet.create(state.doc, [widget]);
          },
        },
      }),

      new Plugin({
        key: rwKey,
        state: {
          init: () => ({ list: [] as Rewrite[] }),
          apply(tr, value) {
            const meta = tr.getMeta(rwKey);
            if (meta !== undefined) return { list: meta as Rewrite[] };
            if (tr.docChanged) return { list: [] };
            return value;
          },
        },
        props: {
          decorations(state) {
            const rw = rwKey.getState(state);
            if (!rw?.list.length) return null;
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              const t = node.text;
              for (const r of rw.list) {
                if (!r.from) continue;
                let idx = t.indexOf(r.from);
                while (idx !== -1) {
                  decos.push(Decoration.inline(pos + idx, pos + idx + r.from.length, { class: "mng-rewrite" }));
                  idx = t.indexOf(r.from, idx + r.from.length);
                }
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setSuggestion: (text: string) => ({ tr, dispatch }) => { if (dispatch) dispatch(tr.setMeta(sugKey, text)); return true; },
      clearSuggestion: () => ({ tr, dispatch }) => { if (dispatch) dispatch(tr.setMeta(sugKey, null)); return true; },
      acceptSuggestion: () => ({ state, tr, dispatch }) => {
        const s = sugKey.getState(state);
        if (!s?.text) return false;
        if (dispatch) dispatch(tr.insertText(s.text, state.selection.head).setMeta(sugKey, null));
        return true;
      },
      setRewrites: (list: Rewrite[]) => ({ tr, dispatch }) => { if (dispatch) dispatch(tr.setMeta(rwKey, list)); return true; },
      clearRewrites: () => ({ tr, dispatch }) => { if (dispatch) dispatch(tr.setMeta(rwKey, [])); return true; },
      acceptRewrite: (from: string, to: string) => ({ state, tr, dispatch }) => {
        const found: { start: number; end: number }[] = [];
        state.doc.descendants((node, pos) => {
          if (found.length) return false;
          if (node.isText && node.text) {
            const idx = node.text.indexOf(from);
            if (idx !== -1) found.push({ start: pos + idx, end: pos + idx + from.length });
          }
          return undefined;
        });
        if (!found.length) return false;
        if (dispatch) dispatch(tr.insertText(to, found[0].start, found[0].end).setMeta(rwKey, []));
        return true;
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.acceptSuggestion(),
      Escape: () => this.editor.commands.clearSuggestion(),
    };
  },
});
