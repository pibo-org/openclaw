import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import {
  clearSessionCookie,
  getAuthenticatedUsername,
  isValidCredentialLogin,
  requireAuthenticatedUsername,
  setSessionCookie,
} from "./auth.server";
import {
  createDirectory,
  createDocument,
  deleteDirectory,
  deleteDocument,
  emptyTrash,
  getDefaultDocumentPath,
  getTrashCount,
  listDocumentTree,
  listTrashItems,
  moveDirectory,
  moveDocument,
  readDocument,
  renameDirectory,
  renameDocument,
  restoreTrashItem,
  saveDocument,
} from "./content.server";
import type { AppBootstrapData } from "./content.shared";

function validateText(value: unknown, fieldName: string) {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${fieldName}`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Missing ${fieldName}`);
  }

  return trimmed;
}

async function buildAuthenticatedBootstrap(
  username: string,
  documentPath?: string | null,
): Promise<AppBootstrapData> {
  const tree = await listDocumentTree();
  const trashCount = await getTrashCount();
  const resolvedDocumentPath = documentPath ?? (await getDefaultDocumentPath());
  const activeDocument = resolvedDocumentPath ? await readDocument(resolvedDocumentPath) : null;

  return {
    authenticated: true,
    username,
    tree,
    activeDocument,
    trashCount,
  };
}

async function buildBootstrap(documentPath?: string | null): Promise<AppBootstrapData> {
  const username = getAuthenticatedUsername();
  if (!username) {
    return {
      authenticated: false,
      username: null,
      tree: [],
      activeDocument: null,
      trashCount: 0,
    };
  }

  return buildAuthenticatedBootstrap(username, documentPath);
}

export const getAppBootstrap = createServerFn({ method: "GET" })
  .inputValidator((data: { documentPath?: string | null } | undefined) => data)
  .handler(async ({ data }) => {
    return buildBootstrap(data?.documentPath ?? null);
  });

export const getExplorerSnapshot = createServerFn({ method: "GET" }).handler(async () => {
  requireAuthenticatedUsername();
  return {
    tree: await listDocumentTree(),
    trashCount: await getTrashCount(),
  };
});

export const loginWithCredentials = createServerFn({ method: "POST" })
  .inputValidator((data: { username: string; password: string }) => ({
    username: validateText(data.username, "username"),
    password: validateText(data.password, "password"),
  }))
  .handler(async ({ data }) => {
    if (!isValidCredentialLogin(data.username, data.password)) {
      setResponseStatus(401);
      throw new Error("Ungültige Zugangsdaten");
    }

    setSessionCookie(data.username);
    return buildAuthenticatedBootstrap(data.username);
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  clearSessionCookie();
  return {
    authenticated: false,
    username: null,
    tree: [],
    activeDocument: null,
    trashCount: 0,
  } satisfies AppBootstrapData;
});

export const loadDocument = createServerFn({ method: "GET" })
  .inputValidator((data: { path: string }) => ({
    path: validateText(data.path, "path"),
  }))
  .handler(async ({ data }) => {
    requireAuthenticatedUsername();
    return readDocument(data.path);
  });

export const persistDocument = createServerFn({ method: "POST" })
  .inputValidator((data: { path: string; markdown: string }) => {
    if (typeof data.markdown !== "string") {
      throw new Error("Invalid markdown");
    }

    return {
      path: validateText(data.path, "path"),
      markdown: data.markdown,
    };
  })
  .handler(async ({ data }) => {
    requireAuthenticatedUsername();
    return saveDocument({
      documentPath: data.path,
      markdown: data.markdown,
    });
  });

export const createNewDocument = createServerFn({ method: "POST" })
  .inputValidator((data: { parentPath?: string | null; name: string }) => ({
    parentPath:
      typeof data.parentPath === "string" && data.parentPath.trim().length > 0
        ? data.parentPath.trim()
        : null,
    name: validateText(data.name, "name"),
  }))
  .handler(async ({ data }) => {
    requireAuthenticatedUsername();
    return createDocument(data);
  });

export const createNewDirectory = createServerFn({ method: "POST" })
  .inputValidator((data: { parentPath?: string | null; name: string }) => ({
    parentPath:
      typeof data.parentPath === "string" && data.parentPath.trim().length > 0
        ? data.parentPath.trim()
        : null,
    name: validateText(data.name, "name"),
  }))
  .handler(async ({ data }) => {
    requireAuthenticatedUsername();
    return createDirectory(data);
  });

export const deleteTreeItem = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      kind: "document" | "directory";
      path: string;
      activeDocumentPath?: string | null;
      selectedFolderPath?: string | null;
    }) => ({
      kind: data.kind,
      path: validateText(data.path, "path"),
      activeDocumentPath:
        typeof data.activeDocumentPath === "string" && data.activeDocumentPath.trim().length > 0
          ? data.activeDocumentPath.trim()
          : null,
      selectedFolderPath:
        typeof data.selectedFolderPath === "string" && data.selectedFolderPath.trim().length > 0
          ? data.selectedFolderPath.trim()
          : null,
    }),
  )
  .handler(async ({ data }) => {
    requireAuthenticatedUsername();

    if (data.kind === "document") {
      return deleteDocument({
        documentPath: data.path,
        activeDocumentPath: data.activeDocumentPath,
        selectedFolderPath: data.selectedFolderPath,
      });
    }

    return deleteDirectory({
      directoryPath: data.path,
      activeDocumentPath: data.activeDocumentPath,
      selectedFolderPath: data.selectedFolderPath,
    });
  });

export const getTrashItems = createServerFn({ method: "GET" }).handler(async () => {
  requireAuthenticatedUsername();
  return listTrashItems();
});

export const restoreTrashEntry = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => ({
    id: validateText(data.id, "id"),
  }))
  .handler(async ({ data }) => {
    requireAuthenticatedUsername();
    return restoreTrashItem({ id: data.id });
  });

export const clearTrash = createServerFn({ method: "POST" }).handler(async () => {
  requireAuthenticatedUsername();
  return emptyTrash();
});

export const moveTreeItem = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      kind: "document" | "directory";
      path: string;
      destinationDirectoryPath?: string | null;
      activeDocumentPath?: string | null;
      selectedFolderPath?: string | null;
    }) => ({
      kind: data.kind,
      path: validateText(data.path, "path"),
      destinationDirectoryPath:
        typeof data.destinationDirectoryPath === "string" &&
        data.destinationDirectoryPath.trim().length > 0
          ? data.destinationDirectoryPath.trim()
          : null,
      activeDocumentPath:
        typeof data.activeDocumentPath === "string" && data.activeDocumentPath.trim().length > 0
          ? data.activeDocumentPath.trim()
          : null,
      selectedFolderPath:
        typeof data.selectedFolderPath === "string" && data.selectedFolderPath.trim().length > 0
          ? data.selectedFolderPath.trim()
          : null,
    }),
  )
  .handler(async ({ data }) => {
    requireAuthenticatedUsername();

    if (data.kind === "document") {
      return moveDocument({
        documentPath: data.path,
        destinationDirectoryPath: data.destinationDirectoryPath,
        activeDocumentPath: data.activeDocumentPath,
        selectedFolderPath: data.selectedFolderPath,
      });
    }

    return moveDirectory({
      directoryPath: data.path,
      destinationDirectoryPath: data.destinationDirectoryPath,
      activeDocumentPath: data.activeDocumentPath,
      selectedFolderPath: data.selectedFolderPath,
    });
  });

export const renameTreeItem = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      kind: "document" | "directory";
      path: string;
      name: string;
      activeDocumentPath?: string | null;
      selectedFolderPath?: string | null;
    }) => ({
      kind: data.kind,
      path: validateText(data.path, "path"),
      name: validateText(data.name, "name"),
      activeDocumentPath:
        typeof data.activeDocumentPath === "string" && data.activeDocumentPath.trim().length > 0
          ? data.activeDocumentPath.trim()
          : null,
      selectedFolderPath:
        typeof data.selectedFolderPath === "string" && data.selectedFolderPath.trim().length > 0
          ? data.selectedFolderPath.trim()
          : null,
    }),
  )
  .handler(async ({ data }) => {
    requireAuthenticatedUsername();

    if (data.kind === "document") {
      return renameDocument({
        documentPath: data.path,
        name: data.name,
        activeDocumentPath: data.activeDocumentPath,
        selectedFolderPath: data.selectedFolderPath,
      });
    }

    return renameDirectory({
      directoryPath: data.path,
      name: data.name,
      activeDocumentPath: data.activeDocumentPath,
      selectedFolderPath: data.selectedFolderPath,
    });
  });
