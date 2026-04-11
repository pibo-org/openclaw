import { ClientOnly } from "@tanstack/react-router";
import { forwardRef, memo, useImperativeHandle, useRef } from "react";
import type { MarkdownEditorHandle } from "./MarkdownEditorClient";
import MarkdownEditorClient from "./MarkdownEditorClient";

type MarkdownEditorProps = {
  documentKey: string;
  initialMarkdown: string;
  onPersist: (markdown: string) => Promise<void>;
  onSaveStateChange: (state: "idle" | "saving" | "saved" | "error") => void;
};

function LoadingEditor() {
  return (
    <div className="editor-loading rounded-[1.5rem] border border-[var(--line)] px-5 py-8 text-sm text-[var(--sea-ink-soft)]">
      Editor wird geladen...
    </div>
  );
}

const MarkdownEditor = memo(
  forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditorImpl(props, ref) {
    const innerRef = useRef<MarkdownEditorHandle>(null);

    useImperativeHandle(ref, () => ({
      flushSave: async () => {
        await innerRef.current?.flushSave();
      },
      getMarkdown: () => innerRef.current?.getMarkdown() ?? props.initialMarkdown,
    }));

    return (
      <ClientOnly fallback={<LoadingEditor />}>
        <MarkdownEditorClient ref={innerRef} {...props} />
      </ClientOnly>
    );
  }),
);

export default MarkdownEditor;
