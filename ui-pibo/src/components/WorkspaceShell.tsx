import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  LogOut,
  PanelLeft,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Copy,
  Trash2,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import MarkdownEditor from "#/components/MarkdownEditor";
import type { MarkdownEditorHandle } from "#/components/MarkdownEditorClient";
import type { SaveState } from "#/components/save-state";
import {
  getSaveState,
  resetSaveState,
  setSaveState,
  subscribeToSaveState,
  useSaveState,
} from "#/components/save-state";
import { useFileSync } from "#/hooks/useFileSync";
import {
  clearTrash,
  createNewDirectory,
  createNewDocument,
  deleteTreeItem,
  getExplorerSnapshot,
  getTrashItems,
  loadDocument,
  logout,
  moveTreeItem,
  renameTreeItem,
  restoreTrashEntry,
} from "#/lib/app.functions";
import type {
  AppBootstrapData,
  DocumentRecord,
  DocumentTreeNode,
  TrashItemRecord,
} from "#/lib/content.shared";

type CreateDialogState = {
  kind: "document" | "folder";
  parentPath: string | null;
} | null;

type ContextMenuTarget = {
  x: number;
  y: number;
  kind: "root" | "directory" | "document";
  targetPath: string | null;
  createParentPath: string | null;
  label: string;
} | null;

type ConfirmDialogState =
  | {
      kind: "delete";
      targetKind: "document" | "directory";
      path: string;
      label: string;
    }
  | {
      kind: "empty-trash";
    }
  | null;

type RenameDialogState = {
  kind: "document" | "directory";
  path: string;
  initialName: string;
} | null;

type DragItemState = {
  kind: "document" | "directory";
  path: string;
  label: string;
} | null;

type WorkspaceShellProps = {
  initialData: AppBootstrapData;
  onLoggedOut: (nextState: AppBootstrapData) => void;
  onDocumentPathChange: (documentPath: string | null) => void;
};

export const WorkspaceShell = memo(function WorkspaceShellComponent({
  initialData,
  onLoggedOut,
  onDocumentPathChange,
}: WorkspaceShellProps) {
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const [tree, setTree] = useState(initialData.tree);
  const [activeDocument, setActiveDocument] = useState(initialData.activeDocument);
  const [selectedDocumentPath, setSelectedDocumentPath] = useState(
    initialData.activeDocument?.path ?? null,
  );
  const [selectedFolderPath, setSelectedFolderPath] = useState(
    getParentDirectory(initialData.activeDocument?.path ?? null),
  );
  const [trashCount, setTrashCount] = useState(initialData.trashCount);
  const [trashItems, setTrashItems] = useState<Array<TrashItemRecord>>([]);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    | "logout"
    | "delete"
    | "restore-trash"
    | "empty-trash"
    | "move"
    | "rename"
    | "refresh-explorer"
    | "refresh-editor"
    | null
  >(null);
  const [createDialog, setCreateDialog] = useState<CreateDialogState>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialogState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);
  const [dragItem, setDragItem] = useState<DragItemState>(null);
  const [dragTargetPath, setDragTargetPath] = useState<string | null>(null);
  const [didCopyContent, setDidCopyContent] = useState(false);
  const [isTrashView, setIsTrashView] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isMobileExplorerOpen, setIsMobileExplorerOpen] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [expandedFolders, setExpandedFolders] = useState<Array<string>>(() =>
    uniquePaths([
      ...collectAncestorPaths(initialData.activeDocument?.path ?? null),
      ...collectAncestorPaths(getParentDirectory(initialData.activeDocument?.path ?? null)),
    ]),
  );

  // Real-time file sync via SSE
  const fileSync = useFileSync();
  const saveStateRef = useRef<SaveState>("idle");
  const selectedDocumentPathRef = useRef(selectedDocumentPath);
  const handleRefreshExplorerRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const handleRefreshEditorRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const refreshExplorerScheduledRef = useRef<number | null>(null);
  const refreshEditorScheduledRef = useRef<number | null>(null);

  // Track saveState in ref for sync callbacks (read directly from store)
  useEffect(() => {
    saveStateRef.current = getSaveState();
    return subscribeToSaveState(() => {
      saveStateRef.current = getSaveState();
    });
  }, []);

  // Keep refs up to date
  useEffect(() => {
    selectedDocumentPathRef.current = selectedDocumentPath;
  }, [selectedDocumentPath]);

  // Subscribe to storage change events — moved below after the refresh callbacks are defined

  const logoutFn = useServerFn(logout);
  const loadDocumentFn = useServerFn(loadDocument);
  const createDocumentFn = useServerFn(createNewDocument);
  const createDirectoryFn = useServerFn(createNewDirectory);
  const deleteTreeItemFn = useServerFn(deleteTreeItem);
  const getExplorerSnapshotFn = useServerFn(getExplorerSnapshot);
  const getTrashItemsFn = useServerFn(getTrashItems);
  const moveTreeItemFn = useServerFn(moveTreeItem);
  const renameTreeItemFn = useServerFn(renameTreeItem);
  const restoreTrashEntryFn = useServerFn(restoreTrashEntry);
  const clearTrashFn = useServerFn(clearTrash);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");

    const syncViewport = (event?: MediaQueryListEvent) => {
      const matches = event?.matches ?? mediaQuery.matches;
      setIsMobileViewport(matches);
      if (!matches) {
        setIsMobileExplorerOpen(false);
      }
    };

    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);

    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    setTree(initialData.tree);
    setActiveDocument(initialData.activeDocument);
    setSelectedDocumentPath(initialData.activeDocument?.path ?? null);
    setSelectedFolderPath(getParentDirectory(initialData.activeDocument?.path ?? null));
    setTrashCount(initialData.trashCount);
    setTrashItems([]);
    setTrashError(null);
    setIsTrashView(false);
    setIsMobileExplorerOpen(false);
    setEditorRevision(0);
    setRenameDialog(null);
    setDragItem(null);
    setDragTargetPath(null);
    setDidCopyContent(false);
    setExpandedFolders(
      uniquePaths([
        ...collectAncestorPaths(initialData.activeDocument?.path ?? null),
        ...collectAncestorPaths(getParentDirectory(initialData.activeDocument?.path ?? null)),
      ]),
    );
    resetSaveState();
  }, [initialData]);

  useEffect(() => {
    setExpandedFolders((current) =>
      uniquePaths([...current, ...collectAncestorPaths(selectedDocumentPath)]),
    );
  }, [selectedDocumentPath]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function closeContextMenu(event: PointerEvent) {
      if (contextMenuRef.current?.contains(event.target as Node | null)) {
        return;
      }

      setContextMenu(null);
    }

    function closeContextMenuOnBlur() {
      setContextMenu(null);
    }

    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("blur", closeContextMenuOnBlur);

    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("blur", closeContextMenuOnBlur);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      return;
    }

    const { width, height } = contextMenuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 12;
    const nextX = Math.min(
      Math.max(contextMenu.x, padding),
      Math.max(padding, viewportWidth - width - padding),
    );
    const nextY = Math.min(
      Math.max(contextMenu.y, padding),
      Math.max(padding, viewportHeight - height - padding),
    );

    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu((current) =>
        current
          ? {
              ...current,
              x: nextX,
              y: nextY,
            }
          : current,
      );
    }
  }, [contextMenu]);

  useEffect(() => {
    if (!isTrashView) {
      return;
    }

    let cancelled = false;

    void getTrashItemsFn()
      .then((items) => {
        if (cancelled) {
          return;
        }
        setTrashItems(items);
        setTrashCount(items.length);
        setTrashError(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setTrashError(
          error instanceof Error ? error.message : "Papierkorb konnte nicht geladen werden",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [getTrashItemsFn, isTrashView]);

  const persistActiveDocument = useCallback(
    async (nextMarkdown: string) => {
      const documentPath = selectedDocumentPath;
      if (!documentPath) {
        return;
      }

      setSaveState("saving");

      try {
        const response = await fetch("/api/documents/save", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            path: documentPath,
            markdown: nextMarkdown,
          }),
        });

        if (!response.ok) {
          throw new Error("Autosave failed");
        }

        fileSync.notifyJustSaved(documentPath);
        setSaveState("saved");
      } catch {
        setSaveState("error");
        throw new Error("Autosave failed");
      }
    },
    [selectedDocumentPath],
  );

  const handleSelectFolder = useCallback((folderPath: string | null) => {
    setIsTrashView(false);
    setSelectedFolderPath(folderPath);
  }, []);

  const openCreateDialog = useCallback((kind: "document" | "folder", parentPath: string | null) => {
    setContextMenu(null);
    setCreateDialog({
      kind,
      parentPath,
    });
  }, []);

  const openRenameDialog = useCallback(
    (kind: "document" | "directory", path: string, initialName: string) => {
      setContextMenu(null);
      setRenameDialog({
        kind,
        path,
        initialName,
      });
    },
    [],
  );

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, target: Exclude<ContextMenuTarget, null>) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        ...target,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    setBusyAction("logout");
    await editorRef.current?.flushSave();
    const nextState = await logoutFn();
    resetSaveState();
    onDocumentPathChange(null);
    onLoggedOut(nextState);
    setBusyAction(null);
  }, [logoutFn, onDocumentPathChange, onLoggedOut]);

  const handleSelectDocument = useCallback(
    async (documentPath: string) => {
      if (documentPath === selectedDocumentPath) {
        setIsTrashView(false);
        if (isMobileViewport) {
          setIsMobileExplorerOpen(false);
        }
        return;
      }

      await editorRef.current?.flushSave();
      resetSaveState();

      const document = await loadDocumentFn({
        data: {
          path: documentPath,
        },
      });

      setIsTrashView(false);
      setActiveDocument(document);
      setSelectedDocumentPath(document.path);
      setSelectedFolderPath(getParentDirectory(document.path));
      if (isMobileViewport) {
        setIsMobileExplorerOpen(false);
      }
      onDocumentPathChange(document.path);
    },
    [isMobileViewport, loadDocumentFn, onDocumentPathChange, selectedDocumentPath],
  );

  const handleCreate = useCallback(
    async (kind: "document" | "folder", name: string, parentPath: string | null) => {
      if (kind === "document") {
        await editorRef.current?.flushSave();
        const result = await createDocumentFn({
          data: {
            name,
            parentPath,
          },
        });

        setIsTrashView(false);
        setTree(result.tree);
        setActiveDocument(result.document);
        setSelectedFolderPath(getParentDirectory(result.document.path));
        setSelectedDocumentPath(result.document.path);
        if (isMobileViewport) {
          setIsMobileExplorerOpen(false);
        }
        setExpandedFolders((current) =>
          uniquePaths([...current, ...collectAncestorPaths(result.document.path)]),
        );
        resetSaveState();
        onDocumentPathChange(result.document.path);
        return;
      }

      const result = await createDirectoryFn({
        data: {
          name,
          parentPath,
        },
      });

      setTree(result.tree);
      setSelectedFolderPath(result.path);
      if (isMobileViewport) {
        setIsMobileExplorerOpen(false);
      }
      setExpandedFolders((current) =>
        uniquePaths([...current, ...collectAncestorPaths(result.path), result.path]),
      );
    },
    [createDirectoryFn, createDocumentFn, isMobileViewport, onDocumentPathChange],
  );

  const handleRename = useCallback(
    async (kind: "document" | "directory", path: string, name: string) => {
      if (
        (kind === "document" && selectedDocumentPath === path) ||
        (kind === "directory" && selectedDocumentPath && isWithinPath(selectedDocumentPath, path))
      ) {
        await editorRef.current?.flushSave();
      }

      setBusyAction("rename");

      try {
        const result = await renameTreeItemFn({
          data: {
            kind,
            path,
            name,
            activeDocumentPath: selectedDocumentPath,
            selectedFolderPath,
          },
        });

        setTree(result.tree);
        setActiveDocument(result.activeDocument);
        setSelectedDocumentPath(result.activeDocument?.path ?? null);
        setSelectedFolderPath(result.selectedFolderPath);
        setExpandedFolders((current) =>
          uniquePaths([
            ...current.filter((entry) => !isWithinPath(entry, path)),
            ...collectAncestorPaths(result.activeDocument?.path ?? null),
            ...collectAncestorPaths(result.selectedFolderPath),
            ...(result.selectedFolderPath ? [result.selectedFolderPath] : []),
          ]),
        );
        resetSaveState();
        onDocumentPathChange(result.activeDocument?.path ?? null);
        setRenameDialog(null);
      } finally {
        setBusyAction(null);
      }
    },
    [onDocumentPathChange, renameTreeItemFn, selectedDocumentPath, selectedFolderPath],
  );

  const handleMoveItem = useCallback(
    async (
      kind: "document" | "directory",
      path: string,
      destinationDirectoryPath: string | null,
    ) => {
      if (
        (kind === "document" && getParentDirectory(path) === destinationDirectoryPath) ||
        (kind === "directory" && getParentDirectory(path) === destinationDirectoryPath)
      ) {
        setDragItem(null);
        setDragTargetPath(null);
        return;
      }

      if (
        kind === "directory" &&
        destinationDirectoryPath &&
        isWithinPath(destinationDirectoryPath, path)
      ) {
        setDragItem(null);
        setDragTargetPath(null);
        return;
      }

      if (
        (kind === "document" && selectedDocumentPath === path) ||
        (kind === "directory" && selectedDocumentPath && isWithinPath(selectedDocumentPath, path))
      ) {
        await editorRef.current?.flushSave();
      }

      setBusyAction("move");

      try {
        const result = await moveTreeItemFn({
          data: {
            kind,
            path,
            destinationDirectoryPath,
            activeDocumentPath: selectedDocumentPath,
            selectedFolderPath,
          },
        });

        setTree(result.tree);
        setActiveDocument(result.activeDocument);
        setSelectedDocumentPath(result.activeDocument?.path ?? null);
        setSelectedFolderPath(result.selectedFolderPath);
        setExpandedFolders((current) =>
          uniquePaths([
            ...current.filter((entry) => !isWithinPath(entry, path)),
            ...collectAncestorPaths(result.activeDocument?.path ?? null),
            ...collectAncestorPaths(result.selectedFolderPath),
            ...(result.selectedFolderPath ? [result.selectedFolderPath] : []),
            ...collectAncestorPaths(destinationDirectoryPath),
            ...(destinationDirectoryPath ? [destinationDirectoryPath] : []),
          ]),
        );
        resetSaveState();
        onDocumentPathChange(result.activeDocument?.path ?? null);
      } finally {
        setBusyAction(null);
        setDragItem(null);
        setDragTargetPath(null);
      }
    },
    [moveTreeItemFn, onDocumentPathChange, selectedDocumentPath, selectedFolderPath],
  );

  const handleDragStart = useCallback(
    (event: ReactDragEvent<HTMLElement>, item: Exclude<DragItemState, null>) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.path);
      setDragItem(item);
      setDragTargetPath(null);
      setContextMenu(null);
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    setDragItem(null);
    setDragTargetPath(null);
  }, []);

  const handleRefreshExplorer = useCallback(async () => {
    setBusyAction("refresh-explorer");

    try {
      const snapshot = await getExplorerSnapshotFn();
      setTree(snapshot.tree);
      setTrashCount(snapshot.trashCount);

      if (isTrashView) {
        const items = await getTrashItemsFn();
        setTrashItems(items);
        setTrashCount(items.length);
        setTrashError(null);
      }
    } finally {
      setBusyAction(null);
    }
  }, [getExplorerSnapshotFn, getTrashItemsFn, isTrashView]);

  const handleRefreshEditor = useCallback(
    async (documentPath?: string | null) => {
      const pathToLoad = documentPath ?? selectedDocumentPathRef.current;
      if (!pathToLoad) {
        return;
      }

      setBusyAction("refresh-editor");

      try {
        const document = await loadDocumentFn({
          data: {
            path: pathToLoad,
          },
        });

        setIsTrashView(false);
        setActiveDocument((current) => {
          if (
            current &&
            current.path === document.path &&
            current.updatedAt === document.updatedAt &&
            current.markdown === document.markdown
          ) {
            return current;
          }
          return document;
        });
        setSelectedDocumentPath(document.path);
        setSelectedFolderPath(getParentDirectory(document.path));
        setEditorRevision((current) => current + 1);
        resetSaveState();
        onDocumentPathChange(document.path);
      } finally {
        setBusyAction(null);
      }
    },
    [loadDocumentFn, onDocumentPathChange],
  );

  // Update refs after callbacks are defined
  useEffect(() => {
    handleRefreshExplorerRef.current = handleRefreshExplorer;
  }, [handleRefreshExplorer]);

  useEffect(() => {
    handleRefreshEditorRef.current = handleRefreshEditor;
  }, [handleRefreshEditor]);

  // Subscribe to file-change events from SSE
  useEffect(() => {
    return fileSync.subscribeFileChange((changedPath, _mtimeMs, eventType) => {
      if (refreshExplorerScheduledRef.current !== null) {
        window.clearTimeout(refreshExplorerScheduledRef.current);
      }
      refreshExplorerScheduledRef.current = window.setTimeout(() => {
        refreshExplorerScheduledRef.current = null;
        void handleRefreshExplorerRef.current();
      }, 250);

      const selectedPath = selectedDocumentPathRef.current;
      if (!selectedPath) {
        return;
      }

      const affectsSelectedDocument =
        changedPath === selectedPath ||
        (eventType === "delete" && selectedPath.startsWith(`${changedPath}/`));

      if (!affectsSelectedDocument) {
        return;
      }

      if (refreshEditorScheduledRef.current !== null) {
        window.clearTimeout(refreshEditorScheduledRef.current);
      }
      const pathToRefresh = changedPath;
      refreshEditorScheduledRef.current = window.setTimeout(() => {
        refreshEditorScheduledRef.current = null;
        setEditorRevision((current) => current + 1);
        void handleRefreshEditorRef.current(pathToRefresh);
      }, 250);
    });
  }, [fileSync]);

  const handleCopyContent = useCallback(async () => {
    if (!activeDocument) {
      return;
    }

    const currentMarkdown = editorRef.current?.getMarkdown() ?? activeDocument.markdown;

    if ("clipboard" in navigator && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(currentMarkdown);
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = currentMarkdown;
      textArea.setAttribute("readonly", "true");
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.append(textArea);
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    }

    setDidCopyContent(true);
    if (copyFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = window.setTimeout(() => {
      setDidCopyContent(false);
      copyFeedbackTimeoutRef.current = null;
    }, 1100);
  }, [activeDocument]);

  const handleDragOverTarget = useCallback(
    (event: ReactDragEvent<HTMLElement>, destinationDirectoryPath: string | null) => {
      if (!dragItem) {
        return;
      }

      if (
        (dragItem.kind === "document" &&
          getParentDirectory(dragItem.path) === destinationDirectoryPath) ||
        (dragItem.kind === "directory" &&
          (dragItem.path === destinationDirectoryPath ||
            (destinationDirectoryPath && isWithinPath(destinationDirectoryPath, dragItem.path)) ||
            getParentDirectory(dragItem.path) === destinationDirectoryPath))
      ) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragTargetPath(destinationDirectoryPath ?? "");
    },
    [dragItem],
  );

  const handleDropOnTarget = useCallback(
    (event: ReactDragEvent<HTMLElement>, destinationDirectoryPath: string | null) => {
      event.preventDefault();
      event.stopPropagation();

      if (!dragItem) {
        return;
      }

      void handleMoveItem(dragItem.kind, dragItem.path, destinationDirectoryPath);
    },
    [dragItem, handleMoveItem],
  );

  const toggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders((current) =>
      current.includes(folderPath)
        ? current.filter((path) => path !== folderPath)
        : [...current, folderPath],
    );
  }, []);

  const handleOpenTrash = useCallback(() => {
    setContextMenu(null);
    setIsTrashView(true);
    setTrashError(null);
    if (isMobileViewport) {
      setIsMobileExplorerOpen(false);
    }
  }, [isMobileViewport]);

  const handleConfirmDelete = useCallback(
    (targetKind: "document" | "directory", path: string, label: string) => {
      setContextMenu(null);
      setConfirmDialog({
        kind: "delete",
        targetKind,
        path,
        label,
      });
    },
    [],
  );

  const submitDelete = useCallback(async () => {
    if (!confirmDialog || confirmDialog.kind !== "delete") {
      return;
    }

    if (confirmDialog.targetKind === "document" && selectedDocumentPath === confirmDialog.path) {
      await editorRef.current?.flushSave();
    }

    if (
      confirmDialog.targetKind === "directory" &&
      selectedDocumentPath &&
      isWithinPath(selectedDocumentPath, confirmDialog.path)
    ) {
      await editorRef.current?.flushSave();
    }

    setBusyAction("delete");

    try {
      const result = await deleteTreeItemFn({
        data: {
          kind: confirmDialog.targetKind,
          path: confirmDialog.path,
          activeDocumentPath: selectedDocumentPath,
          selectedFolderPath,
        },
      });

      setTree(result.tree);
      setActiveDocument(result.activeDocument);
      setSelectedDocumentPath(result.activeDocument?.path ?? null);
      setSelectedFolderPath(result.selectedFolderPath);
      setTrashCount(result.trashCount);
      setTrashItems((items) => items.filter((item) => item.originalPath !== confirmDialog.path));
      setExpandedFolders((current) =>
        current.filter((path) => !isWithinPath(path, confirmDialog.path)),
      );
      resetSaveState();
      onDocumentPathChange(result.activeDocument?.path ?? null);
      setConfirmDialog(null);
    } finally {
      setBusyAction(null);
    }
  }, [
    confirmDialog,
    deleteTreeItemFn,
    onDocumentPathChange,
    selectedDocumentPath,
    selectedFolderPath,
  ]);

  const handleRestoreTrashItem = useCallback(
    async (item: TrashItemRecord) => {
      setBusyAction("restore-trash");

      try {
        const result = await restoreTrashEntryFn({
          data: {
            id: item.id,
          },
        });

        setTree(result.tree);
        setTrashCount(result.trashCount);
        setTrashItems((items) => items.filter((entry) => entry.id !== item.id));
        setTrashError(null);

        if (item.kind === "document" && result.activeDocument) {
          setActiveDocument(result.activeDocument);
          setSelectedDocumentPath(result.activeDocument.path);
          setSelectedFolderPath(getParentDirectory(result.activeDocument.path));
          setExpandedFolders((current) =>
            uniquePaths([...current, ...collectAncestorPaths(result.activeDocument?.path ?? null)]),
          );
          onDocumentPathChange(result.activeDocument.path);
        }

        if (item.kind === "directory") {
          setSelectedFolderPath(result.restoredPath);
          setExpandedFolders((current) =>
            uniquePaths([
              ...current,
              ...collectAncestorPaths(result.restoredPath),
              result.restoredPath,
            ]),
          );
        }
      } finally {
        setBusyAction(null);
      }
    },
    [onDocumentPathChange, restoreTrashEntryFn],
  );

  const handleEmptyTrash = useCallback(async () => {
    setBusyAction("empty-trash");

    try {
      const result = await clearTrashFn();
      setTrashItems(result.items);
      setTrashCount(result.trashCount);
      setConfirmDialog(null);
      setTrashError(null);
    } finally {
      setBusyAction(null);
    }
  }, [clearTrashFn]);

  return (
    <main className="page-wrap page-wrap--editor px-0 pb-6 pt-3 sm:px-2 sm:pb-8 sm:pt-4">
      <section
        className={
          isMobileExplorerOpen
            ? "workspace-shell workspace-shell--obsidian workspace-shell--mobile-explorer-open rise-in"
            : "workspace-shell workspace-shell--obsidian rise-in"
        }
      >
        <FileExplorer
          tree={tree}
          selectedDocumentPath={selectedDocumentPath}
          selectedFolderPath={selectedFolderPath}
          dragItem={dragItem}
          dragTargetPath={dragTargetPath}
          busyAction={busyAction}
          expandedFolders={expandedFolders}
          isTrashView={isTrashView}
          isMobileViewport={isMobileViewport}
          isMobileExplorerOpen={isMobileExplorerOpen}
          trashCount={trashCount}
          onCloseMobileExplorer={() => {
            setIsMobileExplorerOpen(false);
          }}
          onCreateDocument={() => {
            openCreateDialog("document", selectedFolderPath);
          }}
          onCreateFolder={() => {
            openCreateDialog("folder", selectedFolderPath);
          }}
          onLogout={() => {
            void handleLogout();
          }}
          onSelectDocument={(documentPath) => {
            void handleSelectDocument(documentPath);
          }}
          onSelectFolder={handleSelectFolder}
          onToggleFolder={toggleFolder}
          onOpenTrash={handleOpenTrash}
          onContextMenu={openContextMenu}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOverTarget={handleDragOverTarget}
          onDropOnTarget={handleDropOnTarget}
          onRefreshExplorer={() => {
            void handleRefreshExplorer();
          }}
        />

        {isTrashView ? (
          <TrashPane
            items={trashItems}
            trashError={trashError}
            busyAction={busyAction}
            onEmptyTrash={() => {
              setConfirmDialog({ kind: "empty-trash" });
            }}
            onRestoreItem={(item) => {
              void handleRestoreTrashItem(item);
            }}
          />
        ) : (
          <EditorPane
            editorRef={editorRef}
            activeDocument={activeDocument}
            selectedFolderPath={selectedFolderPath}
            isLiveConnected={fileSync.isConnected}
            editorRevision={editorRevision}
            onPersist={persistActiveDocument}
            onOpenContextMenu={openContextMenu}
            isMobileViewport={isMobileViewport}
            isRefreshing={busyAction === "refresh-editor"}
            didCopyContent={didCopyContent}
            onOpenMobileExplorer={() => {
              setIsMobileExplorerOpen(true);
            }}
            onRefreshEditor={() => {
              void handleRefreshEditor();
            }}
            onCopyContent={() => {
              void handleCopyContent();
            }}
          />
        )}

        {isMobileViewport && isMobileExplorerOpen ? (
          <button
            type="button"
            className="mobile-explorer-backdrop"
            aria-label="Explorer schlieÃŸen"
            onClick={() => {
              setIsMobileExplorerOpen(false);
            }}
          />
        ) : null}
      </section>

      {dragTargetPath === "__detached-backdrop__" ? (
        <button
          type="button"
          className="mobile-explorer-backdrop"
          aria-label="Explorer schließen"
          onClick={() => {
            setIsMobileExplorerOpen(false);
          }}
        />
      ) : null}

      {createDialog ? (
        <CreateItemDialog
          kind={createDialog.kind}
          parentPath={createDialog.parentPath}
          onClose={() => {
            setCreateDialog(null);
          }}
          onCreate={async (name) => {
            await handleCreate(createDialog.kind, name, createDialog.parentPath);
            setCreateDialog(null);
          }}
        />
      ) : null}

      {renameDialog ? (
        <RenameItemDialog
          kind={renameDialog.kind}
          initialName={renameDialog.initialName}
          busy={busyAction === "rename"}
          onClose={() => {
            setRenameDialog(null);
          }}
          onRename={async (name) => {
            await handleRename(renameDialog.kind, renameDialog.path, name);
          }}
        />
      ) : null}

      {confirmDialog ? (
        <ConfirmActionDialog
          title={
            confirmDialog.kind === "delete"
              ? confirmDialog.targetKind === "document"
                ? "Note löschen"
                : "Ordner löschen"
              : "Papierkorb leeren"
          }
          description={
            confirmDialog.kind === "delete"
              ? confirmDialog.targetKind === "document"
                ? `„${confirmDialog.label}“ wird in den Papierkorb verschoben.`
                : `„${confirmDialog.label}“ und alle enthaltenen Elemente werden in den Papierkorb verschoben.`
              : "Alle Elemente im Papierkorb werden endgültig entfernt."
          }
          confirmLabel={confirmDialog.kind === "delete" ? "Löschen" : "Papierkorb leeren"}
          busy={busyAction === "delete" || busyAction === "empty-trash"}
          danger
          onClose={() => {
            setConfirmDialog(null);
          }}
          onConfirm={() => {
            if (confirmDialog.kind === "delete") {
              void submitDelete();
              return;
            }

            void handleEmptyTrash();
          }}
        />
      ) : null}

      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => {
            event.preventDefault();
          }}
        >
          <div className="context-menu__label">{contextMenu.label}</div>
          {contextMenu.kind !== "document" ? (
            <>
              <button
                type="button"
                className="context-menu__item"
                onClick={() => {
                  openCreateDialog("document", contextMenu.createParentPath);
                }}
              >
                <FilePlus2 className="h-4 w-4" />
                Neue Note
              </button>
              <button
                type="button"
                className="context-menu__item"
                onClick={() => {
                  openCreateDialog("folder", contextMenu.createParentPath);
                }}
              >
                <FolderPlus className="h-4 w-4" />
                Neuer Ordner
              </button>
            </>
          ) : null}
          {contextMenu.targetPath ? (
            <button
              type="button"
              className="context-menu__item"
              onClick={() => {
                openRenameDialog(
                  contextMenu.kind === "directory" ? "directory" : "document",
                  contextMenu.targetPath,
                  contextMenu.label,
                );
              }}
            >
              <Pencil className="h-4 w-4" />
              Umbenennen
            </button>
          ) : null}
          {contextMenu.targetPath ? (
            <button
              type="button"
              className="context-menu__item context-menu__item--danger"
              onClick={() => {
                handleConfirmDelete(
                  contextMenu.kind === "directory" ? "directory" : "document",
                  contextMenu.targetPath,
                  contextMenu.label,
                );
              }}
            >
              <Trash2 className="h-4 w-4" />
              Löschen
            </button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
});

const FileExplorer = memo(function FileExplorerComponent(props: {
  tree: Array<DocumentTreeNode>;
  selectedDocumentPath: string | null;
  selectedFolderPath: string | null;
  dragItem: DragItemState;
  dragTargetPath: string | null;
  busyAction:
    | "logout"
    | "delete"
    | "restore-trash"
    | "empty-trash"
    | "move"
    | "rename"
    | "refresh-explorer"
    | "refresh-editor"
    | null;
  expandedFolders: Array<string>;
  isTrashView: boolean;
  isMobileViewport: boolean;
  isMobileExplorerOpen: boolean;
  trashCount: number;
  onCloseMobileExplorer: () => void;
  onCreateDocument: () => void;
  onCreateFolder: () => void;
  onLogout: () => void;
  onSelectDocument: (documentPath: string) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onToggleFolder: (folderPath: string) => void;
  onOpenTrash: () => void;
  onContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: Exclude<ContextMenuTarget, null>,
  ) => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>, item: Exclude<DragItemState, null>) => void;
  onDragEnd: () => void;
  onDragOverTarget: (
    event: ReactDragEvent<HTMLElement>,
    destinationDirectoryPath: string | null,
  ) => void;
  onDropOnTarget: (
    event: ReactDragEvent<HTMLElement>,
    destinationDirectoryPath: string | null,
  ) => void;
  onRefreshExplorer: () => void;
}) {
  return (
    <aside
      className={
        props.isMobileViewport
          ? props.isMobileExplorerOpen
            ? "explorer-panel explorer-panel--mobile explorer-panel--mobile-open"
            : "explorer-panel explorer-panel--mobile"
          : "explorer-panel"
      }
      aria-hidden={props.isMobileViewport && !props.isMobileExplorerOpen}
    >
      <div className="explorer-toolbar">
        <div>
          <p className="explorer-eyebrow">Vault</p>
          <h1 className="explorer-title">Markdown Files</h1>
        </div>
        <div className="explorer-actions">
          {props.isMobileViewport ? (
            <button
              type="button"
              className="icon-button mobile-only-button"
              title="Explorer schließen"
              onClick={props.onCloseMobileExplorer}
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            title="Neue Note"
            onClick={props.onCreateDocument}
          >
            <FilePlus2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Neuer Ordner"
            onClick={props.onCreateFolder}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Explorer aktualisieren"
            onClick={props.onRefreshExplorer}
            disabled={props.busyAction === "refresh-explorer"}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Logout"
            onClick={props.onLogout}
            disabled={props.busyAction === "logout"}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="explorer-meta">
        <span>{countDocuments(props.tree)} Dateien</span>
        <span>
          {props.selectedFolderPath ? `Ordner: ${props.selectedFolderPath}` : "Ordner: Root"}
        </span>
      </div>

      <div
        className="explorer-tree"
        onContextMenu={(event) => {
          props.onContextMenu(event, {
            x: 0,
            y: 0,
            kind: "root",
            targetPath: null,
            createParentPath: props.selectedFolderPath,
            label: props.selectedFolderPath ? props.selectedFolderPath : "Root",
          });
        }}
      >
        <button
          type="button"
          className={
            props.selectedFolderPath === null && !props.isTrashView
              ? props.dragTargetPath === "" && props.dragItem
                ? "explorer-row explorer-row--folder explorer-row--active explorer-row--drop-target"
                : "explorer-row explorer-row--folder explorer-row--active"
              : props.dragTargetPath === "" && props.dragItem
                ? "explorer-row explorer-row--folder explorer-row--drop-target"
                : "explorer-row explorer-row--folder"
          }
          onClick={() => {
            props.onSelectFolder(null);
          }}
          onDragOver={(event) => {
            props.onDragOverTarget(event, null);
          }}
          onDrop={(event) => {
            props.onDropOnTarget(event, null);
          }}
          onContextMenu={(event) => {
            props.onContextMenu(event, {
              x: 0,
              y: 0,
              kind: "root",
              targetPath: null,
              createParentPath: null,
              label: "Root",
            });
          }}
        >
          <FolderOpen className="h-4 w-4" />
          <span>Root</span>
        </button>

        <DocumentTree
          nodes={props.tree}
          selectedDocumentPath={props.selectedDocumentPath}
          selectedFolderPath={props.selectedFolderPath}
          expandedFolders={props.expandedFolders}
          dragItem={props.dragItem}
          dragTargetPath={props.dragTargetPath}
          isMobileViewport={props.isMobileViewport}
          onSelectDocument={props.onSelectDocument}
          onSelectFolder={props.onSelectFolder}
          onToggleFolder={props.onToggleFolder}
          onContextMenu={props.onContextMenu}
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          onDragOverTarget={props.onDragOverTarget}
          onDropOnTarget={props.onDropOnTarget}
        />

        <button
          type="button"
          className={
            props.isTrashView
              ? "explorer-row explorer-row--trash explorer-row--active"
              : "explorer-row explorer-row--trash"
          }
          onClick={props.onOpenTrash}
        >
          <Trash2 className="h-4 w-4" />
          <span>Papierkorb</span>
          <span className="explorer-badge">{props.trashCount}</span>
        </button>
      </div>
    </aside>
  );
});

const EditorPane = memo(function EditorPaneComponent(props: {
  editorRef: RefObject<MarkdownEditorHandle>;
  activeDocument: DocumentRecord | null;
  selectedFolderPath: string | null;
  isLiveConnected: boolean;
  editorRevision: number;
  isMobileViewport: boolean;
  isRefreshing: boolean;
  didCopyContent: boolean;
  onPersist: (markdown: string) => Promise<void>;
  onOpenMobileExplorer: () => void;
  onRefreshEditor: () => void;
  onCopyContent: () => void;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: Exclude<ContextMenuTarget, null>,
  ) => void;
}) {
  return (
    <section className="editor-panel editor-panel--obsidian">
      <div className="editor-topbar">
        <div className="editor-heading">
          {props.isMobileViewport ? (
            <button
              type="button"
              className="icon-button mobile-explorer-toggle"
              title="Explorer öffnen"
              onClick={props.onOpenMobileExplorer}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          ) : null}
          <p className="explorer-eyebrow">Editor</p>
          <h2 className="editor-title">{props.activeDocument?.name ?? "Keine Note"}</h2>
          {props.activeDocument?.path ? (
            <p className="editor-path">{props.activeDocument.path}</p>
          ) : null}
        </div>
        <div className="editor-status">
          <SaveIndicator />
          <span
            className={
              props.isLiveConnected ? "save-pill save-pill--saved" : "save-pill save-pill--error"
            }
            title={props.isLiveConnected ? "Live-Sync verbunden" : "Live-Sync getrennt"}
          >
            {props.isLiveConnected ? "Live" : "Offline"}
          </span>
          <button
            type="button"
            className={
              props.didCopyContent ? "icon-button icon-button--success-flash" : "icon-button"
            }
            title="Inhalt kopieren"
            onClick={props.onCopyContent}
            disabled={!props.activeDocument}
          >
            <Copy className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Editor aktualisieren"
            onClick={props.onRefreshEditor}
            disabled={!props.activeDocument || props.isRefreshing}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {props.activeDocument ? (
            <button
              type="button"
              className="icon-button"
              title="Aktionen"
              onClick={(event) => {
                props.onOpenContextMenu(event, {
                  x: 0,
                  y: 0,
                  kind: "document",
                  targetPath: props.activeDocument?.path ?? null,
                  createParentPath: getParentDirectory(props.activeDocument?.path ?? null),
                  label: props.activeDocument?.name ?? "Note",
                });
              }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {props.activeDocument ? (
        <div className="editor-frame editor-frame--obsidian">
          <MarkdownEditor
            ref={props.editorRef}
            documentKey={`${props.activeDocument.path}:${props.activeDocument.updatedAt}:${props.editorRevision}`}
            initialMarkdown={props.activeDocument.markdown}
            onPersist={props.onPersist}
            onSaveStateChange={setSaveState}
          />
        </div>
      ) : (
        <div className="editor-empty editor-empty--obsidian">
          <Plus className="h-5 w-5" />
          Lege im Explorer eine neue Note an.
        </div>
      )}
    </section>
  );
});

const TrashPane = memo(function TrashPaneComponent(props: {
  items: Array<TrashItemRecord>;
  trashError: string | null;
  busyAction:
    | "logout"
    | "delete"
    | "restore-trash"
    | "empty-trash"
    | "move"
    | "rename"
    | "refresh-explorer"
    | "refresh-editor"
    | null;
  onEmptyTrash: () => void;
  onRestoreItem: (item: TrashItemRecord) => void;
}) {
  return (
    <section className="editor-panel editor-panel--obsidian">
      <div className="editor-topbar">
        <div>
          <p className="explorer-eyebrow">Papierkorb</p>
          <h2 className="editor-title">Gelöschte Elemente</h2>
        </div>
        <div className="editor-status">
          <button
            type="button"
            className="ghost-button ghost-button--danger"
            onClick={props.onEmptyTrash}
            disabled={props.items.length === 0 || props.busyAction === "empty-trash"}
          >
            <Trash2 className="h-4 w-4" />
            Papierkorb leeren
          </button>
        </div>
      </div>

      {props.trashError ? <p className="auth-error">{props.trashError}</p> : null}

      {props.items.length === 0 ? (
        <div className="editor-empty editor-empty--obsidian">
          <Trash2 className="h-5 w-5" />
          Der Papierkorb ist leer.
        </div>
      ) : (
        <div className="trash-list">
          {props.items.map((item) => (
            <article key={item.id} className="trash-card">
              <div className="trash-card__body">
                <div className="trash-card__title">
                  {item.kind === "directory" ? (
                    <Folder className="h-4 w-4" />
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                  <span>{item.name}</span>
                </div>
                <div className="trash-card__meta">
                  <span>{item.kind === "directory" ? "Ordner" : "Note"}</span>
                  <span>Ursprung: {item.originalPath}</span>
                  <span>Gelöscht: {formatTimestamp(item.deletedAt)}</span>
                  <span>Mindestens bis: {formatTimestamp(item.purgeAfter)}</span>
                </div>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  props.onRestoreItem(item);
                }}
                disabled={props.busyAction === "restore-trash"}
              >
                <RotateCcw className="h-4 w-4" />
                Wiederherstellen
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
});

const SaveIndicator = memo(function SaveIndicatorComponent() {
  const saveState = useSaveState();

  return (
    <span className={`save-pill save-pill--${saveState}`}>
      <Save className="h-4 w-4" />
      {saveStateLabel(saveState)}
    </span>
  );
});

function CreateItemDialog(props: {
  kind: "document" | "folder";
  parentPath: string | null;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        props.onClose();
      }}
    >
      <form
        className="modal-card"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const name = formData.get("name");
          if (typeof name !== "string" || !name.trim()) {
            return;
          }
          void props.onCreate(name.trim());
        }}
      >
        <div className="modal-head">
          <div>
            <p className="explorer-eyebrow">
              {props.kind === "document" ? "Neue Note" : "Neuer Ordner"}
            </p>
            <h3 className="modal-title">{props.parentPath ? props.parentPath : "Root"}</h3>
          </div>
          <button type="button" className="icon-button" onClick={props.onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <input
          name="name"
          autoFocus
          className="auth-input"
          placeholder={props.kind === "document" ? "Notizname" : "Ordnername"}
        />

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={props.onClose}>
            Abbrechen
          </button>
          <button type="submit" className="primary-button">
            Erstellen
          </button>
        </div>
      </form>
    </div>
  );
}

function RenameItemDialog(props: {
  kind: "document" | "directory";
  initialName: string;
  busy: boolean;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <form
        className="modal-card"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const name = formData.get("name");
          if (typeof name !== "string" || !name.trim()) {
            return;
          }
          void props.onRename(name.trim());
        }}
      >
        <div className="modal-head">
          <div>
            <p className="explorer-eyebrow">Umbenennen</p>
            <h3 className="modal-title">{props.kind === "document" ? "Note" : "Ordner"}</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={props.onClose}
            disabled={props.busy}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <input
          name="name"
          autoFocus
          defaultValue={props.initialName}
          className="auth-input"
          placeholder={props.kind === "document" ? "Notizname" : "Ordnername"}
        />

        <div className="modal-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={props.onClose}
            disabled={props.busy}
          >
            Abbrechen
          </button>
          <button type="submit" className="primary-button" disabled={props.busy}>
            {props.busy ? "Umbenennen..." : "Umbenennen"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmActionDialog(props: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal-card"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="confirm-dialog__body">
          <div className="confirm-dialog__icon">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <p className="explorer-eyebrow">Bestätigung</p>
            <h3 className="modal-title">{props.title}</h3>
            <p className="confirm-dialog__copy">{props.description}</p>
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={props.onClose}>
            Abbrechen
          </button>
          <button
            type="button"
            className={props.danger ? "ghost-button ghost-button--danger" : "primary-button"}
            onClick={props.onConfirm}
            disabled={props.busy}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const DocumentTree = memo(function DocumentTreeComponent(props: {
  nodes: Array<DocumentTreeNode>;
  selectedDocumentPath: string | null;
  selectedFolderPath: string | null;
  expandedFolders: Array<string>;
  dragItem: DragItemState;
  dragTargetPath: string | null;
  isMobileViewport: boolean;
  onSelectDocument: (documentPath: string) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onToggleFolder: (folderPath: string) => void;
  onContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    target: Exclude<ContextMenuTarget, null>,
  ) => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>, item: Exclude<DragItemState, null>) => void;
  onDragEnd: () => void;
  onDragOverTarget: (
    event: ReactDragEvent<HTMLElement>,
    destinationDirectoryPath: string | null,
  ) => void;
  onDropOnTarget: (
    event: ReactDragEvent<HTMLElement>,
    destinationDirectoryPath: string | null,
  ) => void;
  depth?: number;
}) {
  const depth = props.depth ?? 0;

  if (props.nodes.length === 0) {
    return null;
  }

  return (
    <div className="explorer-group">
      {props.nodes.map((node) =>
        node.kind === "directory" ? (
          <div key={`${node.kind}:${node.path}`}>
            <div className="explorer-folder-row" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
              <button
                type="button"
                className={
                  props.expandedFolders.includes(node.path)
                    ? "explorer-disclosure explorer-disclosure--open"
                    : "explorer-disclosure"
                }
                aria-label={
                  props.expandedFolders.includes(node.path)
                    ? "Ordner einklappen"
                    : "Ordner ausklappen"
                }
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFolder(node.path);
                }}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={
                  node.path === props.selectedFolderPath
                    ? props.dragTargetPath === node.path
                      ? props.dragItem?.path === node.path
                        ? "explorer-row explorer-row--folder explorer-row--active explorer-row--drop-target explorer-row--dragging"
                        : "explorer-row explorer-row--folder explorer-row--active explorer-row--drop-target"
                      : props.dragItem?.path === node.path
                        ? "explorer-row explorer-row--folder explorer-row--active explorer-row--dragging"
                        : "explorer-row explorer-row--folder explorer-row--active"
                    : props.dragTargetPath === node.path
                      ? props.dragItem?.path === node.path
                        ? "explorer-row explorer-row--folder explorer-row--drop-target explorer-row--dragging"
                        : "explorer-row explorer-row--folder explorer-row--drop-target"
                      : props.dragItem?.path === node.path
                        ? "explorer-row explorer-row--folder explorer-row--dragging"
                        : "explorer-row explorer-row--folder"
                }
                aria-expanded={props.expandedFolders.includes(node.path)}
                draggable={!props.isMobileViewport}
                onClick={() => {
                  props.onSelectFolder(node.path);
                  props.onToggleFolder(node.path);
                }}
                onDragStart={(event) => {
                  props.onDragStart(event, {
                    kind: "directory",
                    path: node.path,
                    label: node.name,
                  });
                }}
                onDragEnd={props.onDragEnd}
                onDragOver={(event) => {
                  props.onDragOverTarget(event, node.path);
                }}
                onDrop={(event) => {
                  props.onDropOnTarget(event, node.path);
                }}
                onContextMenu={(event) => {
                  props.onContextMenu(event, {
                    x: 0,
                    y: 0,
                    kind: "directory",
                    targetPath: node.path,
                    createParentPath: node.path,
                    label: node.name,
                  });
                }}
              >
                {props.expandedFolders.includes(node.path) ? (
                  <FolderOpen className="h-4 w-4" />
                ) : (
                  <Folder className="h-4 w-4" />
                )}
                <span>{node.name}</span>
              </button>
            </div>

            {props.expandedFolders.includes(node.path) ? (
              <DocumentTree
                nodes={node.children ?? []}
                selectedDocumentPath={props.selectedDocumentPath}
                selectedFolderPath={props.selectedFolderPath}
                expandedFolders={props.expandedFolders}
                dragItem={props.dragItem}
                dragTargetPath={props.dragTargetPath}
                isMobileViewport={props.isMobileViewport}
                onSelectDocument={props.onSelectDocument}
                onSelectFolder={props.onSelectFolder}
                onToggleFolder={props.onToggleFolder}
                onContextMenu={props.onContextMenu}
                onDragStart={props.onDragStart}
                onDragEnd={props.onDragEnd}
                onDragOverTarget={props.onDragOverTarget}
                onDropOnTarget={props.onDropOnTarget}
                depth={depth + 1}
              />
            ) : null}
          </div>
        ) : (
          <button
            key={`${node.kind}:${node.path}`}
            type="button"
            className={
              node.path === props.selectedDocumentPath
                ? props.dragItem?.path === node.path
                  ? "explorer-row explorer-row--document explorer-row--active explorer-row--dragging"
                  : "explorer-row explorer-row--document explorer-row--active"
                : props.dragItem?.path === node.path
                  ? "explorer-row explorer-row--document explorer-row--dragging"
                  : "explorer-row explorer-row--document"
            }
            style={{ paddingLeft: `${depth * 14 + 36}px` }}
            draggable={!props.isMobileViewport}
            onClick={() => {
              props.onSelectDocument(node.path);
            }}
            onDragStart={(event) => {
              props.onDragStart(event, {
                kind: "document",
                path: node.path,
                label: node.name,
              });
            }}
            onDragEnd={props.onDragEnd}
            onContextMenu={(event) => {
              props.onContextMenu(event, {
                x: 0,
                y: 0,
                kind: "document",
                targetPath: node.path,
                createParentPath: getParentDirectory(node.path),
                label: node.name,
              });
            }}
          >
            <FileText className="h-4 w-4" />
            <span>{node.name}</span>
          </button>
        ),
      )}
    </div>
  );
});

function getParentDirectory(documentPath: string | null | undefined) {
  if (!documentPath || !documentPath.includes("/")) {
    return null;
  }

  return documentPath.split("/").slice(0, -1).join("/");
}

function collectAncestorPaths(targetPath: string | null | undefined) {
  if (!targetPath) {
    return [];
  }

  const parts = targetPath.split("/").filter(Boolean);
  if (parts.length === 0) {
    return [];
  }

  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function uniquePaths(paths: Array<string>) {
  return Array.from(new Set(paths.filter(Boolean)));
}

function countDocuments(nodes: Array<DocumentTreeNode>): number {
  return nodes.reduce((count, node) => {
    if (node.kind === "document") {
      return count + 1;
    }
    return count + countDocuments(node.children ?? []);
  }, 0);
}

function isWithinPath(candidatePath: string | null | undefined, parentPath: string) {
  if (!candidatePath) {
    return false;
  }

  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function saveStateLabel(saveState: SaveState) {
  if (saveState === "saving") {
    return "Speichert...";
  }
  if (saveState === "saved") {
    return "Gespeichert";
  }
  if (saveState === "error") {
    return "Fehler";
  }
  return "Bereit";
}
