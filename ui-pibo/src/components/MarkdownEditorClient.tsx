import "@tanstack/react-start/client-only";
import "#/lib/prism-client";
import type { MDXEditorMethods } from "@mdxeditor/editor";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeMirrorEditor,
  CodeToggle,
  CreateLink,
  DiffSourceToggleWrapper,
  IS_CODE,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  frontmatterPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  realmPlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  createRootEditorSubscription$,
} from "@mdxeditor/editor";
import {
  $getSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_RIGHT_COMMAND,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from "lexical";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import "@mdxeditor/editor/style.css";

type SaveState = "idle" | "saving" | "saved" | "error";

type MarkdownEditorClientProps = {
  documentKey: string;
  initialMarkdown: string;
  onPersist: (markdown: string) => Promise<void>;
  onSaveStateChange: (state: SaveState) => void;
};

export type MarkdownEditorHandle = {
  flushSave: () => Promise<void>;
  getMarkdown: () => string;
} | null;

const AUTOSAVE_DELAY_MS = 900;

const CODE_BLOCK_LANGUAGES = {
  txt: "Text",
  text: "Text",
  plaintext: "Plain Text",
  md: "Markdown",
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  json: "JSON",
  css: "CSS",
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  yaml: "YAML",
  yml: "YAML",
  cron: "Cron",
} as const;

function getInlineCodeExitTarget(node: TextNode): {
  parent: ElementNode;
  offset: number;
} | null {
  let current: LexicalNode = node;
  let movedAcrossInlineBoundary = false;

  while (true) {
    const parent = current.getParent();
    if (parent === null || $isRootOrShadowRoot(parent)) {
      return null;
    }

    const nextSibling = current.getNextSibling();
    if (nextSibling !== null) {
      if (!movedAcrossInlineBoundary && $isTextNode(nextSibling)) {
        return null;
      }

      return {
        parent,
        offset: current.getIndexWithinParent() + 1,
      };
    }

    if (!parent.isInline()) {
      return {
        parent,
        offset: current.getIndexWithinParent() + 1,
      };
    }

    current = parent;
    movedAcrossInlineBoundary = true;
  }
}

const inlineCodeArrowExitPlugin = realmPlugin({
  init(realm) {
    realm.pub(createRootEditorSubscription$, (editor) => {
      return editor.registerCommand(
        KEY_ARROW_RIGHT_COMMAND,
        (event) => {
          if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
            return false;
          }

          let handled = false;

          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
              return;
            }

            if (selection.anchor.type !== "text") {
              return;
            }

            const anchorNode = selection.anchor.getNode();
            if (
              !$isTextNode(anchorNode) ||
              (anchorNode.getFormat() & IS_CODE) === 0 ||
              selection.anchor.offset !== anchorNode.getTextContentSize()
            ) {
              return;
            }

            const exitTarget = getInlineCodeExitTarget(anchorNode);
            if (exitTarget === null) {
              return;
            }

            selection.anchor.set(exitTarget.parent.getKey(), exitTarget.offset, "element");
            selection.focus.set(exitTarget.parent.getKey(), exitTarget.offset, "element");
            selection.setFormat(selection.format & ~IS_CODE);
            handled = true;
          });

          if (!handled) {
            return false;
          }

          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      );
    });
  },
});

const MarkdownEditorClient = memo(
  forwardRef<Exclude<MarkdownEditorHandle, null>, MarkdownEditorClientProps>(
    function MarkdownEditorClientImpl(
      { documentKey, initialMarkdown, onPersist, onSaveStateChange },
      ref,
    ) {
      const editorRef = useRef<MDXEditorMethods>(null);
      const previousDocumentKeyRef = useRef(documentKey);
      const currentMarkdownRef = useRef(initialMarkdown);
      const savedMarkdownRef = useRef(initialMarkdown);
      const savePromiseRef = useRef<Promise<void> | null>(null);
      const timeoutRef = useRef<number | null>(null);
      const [editorMode, setEditorMode] = useState<"rich" | "plain">("rich");
      const [plainMarkdown, setPlainMarkdown] = useState(initialMarkdown);

      const clearAutosaveTimer = useCallback(() => {
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
      }, []);

      const persistIfNeeded = useCallback(async () => {
        if (savePromiseRef.current) {
          await savePromiseRef.current;
        }

        const nextMarkdown = currentMarkdownRef.current;
        if (nextMarkdown === savedMarkdownRef.current) {
          onSaveStateChange("saved");
          return;
        }

        onSaveStateChange("saving");

        const savePromise = (async () => {
          await onPersist(nextMarkdown);
          savedMarkdownRef.current = nextMarkdown;
        })();

        savePromiseRef.current = savePromise;

        try {
          await savePromise;
          if (currentMarkdownRef.current === savedMarkdownRef.current) {
            onSaveStateChange("saved");
            return;
          }

          await persistIfNeeded();
        } catch {
          onSaveStateChange("error");
          throw new Error("Autosave failed");
        } finally {
          if (savePromiseRef.current === savePromise) {
            savePromiseRef.current = null;
          }
        }
      }, [onPersist, onSaveStateChange]);

      const scheduleAutosave = useCallback(() => {
        clearAutosaveTimer();
        timeoutRef.current = window.setTimeout(() => {
          timeoutRef.current = null;
          void persistIfNeeded();
        }, AUTOSAVE_DELAY_MS);
      }, [clearAutosaveTimer, persistIfNeeded]);

      const handleEditorChange = useCallback(
        (markdown: string) => {
          currentMarkdownRef.current = markdown;
          onSaveStateChange("idle");
          scheduleAutosave();
        },
        [onSaveStateChange, scheduleAutosave],
      );

      const handlePlainEditorChange = useCallback(
        (markdown: string) => {
          setPlainMarkdown(markdown);
          currentMarkdownRef.current = markdown;
          onSaveStateChange("idle");
          scheduleAutosave();
        },
        [onSaveStateChange, scheduleAutosave],
      );

      const uploadImage = useCallback(async (file: File) => {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch("/api/uploads", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          throw new Error("Image upload failed");
        }

        const data = (await response.json()) as { url: string };
        return data.url;
      }, []);

      const plugins = useMemo(
        () => [
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          imagePlugin({
            imageUploadHandler: uploadImage,
          }),
          tablePlugin(),
          codeBlockPlugin({
            defaultCodeBlockLanguage: "txt",
            // Catch-all for fenced code blocks whose language is not in our curated list.
            // Without this, MDXEditor can fail to materialize imported markdown code nodes.
            codeBlockEditorDescriptors: [
              {
                priority: -10,
                match: () => true,
                Editor: CodeMirrorEditor,
              },
            ],
          }),
          codeMirrorPlugin({
            codeBlockLanguages: CODE_BLOCK_LANGUAGES,
          }),
          frontmatterPlugin(),
          diffSourcePlugin({ viewMode: "rich-text" }),
          markdownShortcutPlugin(),
          inlineCodeArrowExitPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BoldItalicUnderlineToggles />
                <CodeToggle />
                <BlockTypeSelect />
                <ListsToggle />
                <CreateLink />
                <InsertImage />
                <InsertTable />
                <InsertThematicBreak />
                <InsertCodeBlock />
                <DiffSourceToggleWrapper options={["rich-text", "source"]} />
              </>
            ),
          }),
        ],
        [uploadImage],
      );

      useImperativeHandle(ref, () => ({
        flushSave: async () => {
          clearAutosaveTimer();
          await persistIfNeeded();
        },
        getMarkdown: () => currentMarkdownRef.current,
      }));

      useEffect(() => {
        return () => {
          clearAutosaveTimer();
        };
      }, []);

      useEffect(() => {
        const documentChanged = previousDocumentKeyRef.current !== documentKey;
        const contentChangedExternally = initialMarkdown !== savedMarkdownRef.current;

        if (!documentChanged && !contentChangedExternally) {
          return;
        }

        previousDocumentKeyRef.current = documentKey;
        clearAutosaveTimer();
        savePromiseRef.current = null;
        currentMarkdownRef.current = initialMarkdown;
        savedMarkdownRef.current = initialMarkdown;
        setPlainMarkdown(initialMarkdown);
        setEditorMode("rich");
        onSaveStateChange("idle");
        editorRef.current?.setMarkdown(initialMarkdown);
      }, [documentKey, initialMarkdown, onSaveStateChange, clearAutosaveTimer]);

      if (editorMode === "plain") {
        return (
          <div className="plain-markdown-fallback">
            <p className="plain-markdown-fallback__notice">
              Der Rich-Text-Editor konnte dieses Dokument nicht sicher laden. Du arbeitest deshalb
              im Rohtext-Modus.
            </p>
            <textarea
              className="plain-markdown-fallback__textarea"
              value={plainMarkdown}
              onChange={(event) => {
                handlePlainEditorChange(event.currentTarget.value);
              }}
              spellCheck={false}
            />
          </div>
        );
      }

      return (
        <MDXEditor
          ref={editorRef}
          markdown={initialMarkdown}
          onChange={handleEditorChange}
          onError={(payload) => {
            console.error("MDXEditor error", payload);
            setPlainMarkdown(currentMarkdownRef.current);
            setEditorMode("plain");
          }}
          contentEditableClassName="mdx-content"
          plugins={plugins}
        />
      );
    },
  ),
);

export default MarkdownEditorClient;
