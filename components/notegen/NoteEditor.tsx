"use client";

import { useEffect } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { GhostSuggestion } from "./ghost-suggestion";

/**
 * The note editor (TipTap / ProseMirror). Always editable.
 * R3 adds the GhostSuggestion extension (inline completions). onReady exposes the
 * editor instance so the page can set ghost suggestions and insert chip text.
 */
export default function NoteEditor({
  placeholder = "Start writing or dictating the note… shorthand is fine.",
  onChange,
  onReady,
}: {
  placeholder?: string;
  onChange?: (text: string, html: string) => void;
  onReady?: (editor: Editor) => void;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Placeholder.configure({ placeholder }), GhostSuggestion],
    content: "",
    onUpdate: ({ editor }) => onChange?.(editor.getText(), editor.getHTML()),
    editorProps: { attributes: { "aria-label": "Clinical note editor", spellcheck: "true" } },
  });

  useEffect(() => { if (editor && onReady) onReady(editor); }, [editor, onReady]);

  return <EditorContent editor={editor} />;
}
