import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename as movePath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { DocumentRecord, DocumentTreeNode, TrashItemRecord } from "./content.shared";

const MIN_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type TrashMetaRecord = TrashItemRecord & {
  trashPath: string;
};

type DeleteResult = {
  tree: Array<DocumentTreeNode>;
  activeDocument: DocumentRecord | null;
  selectedFolderPath: string | null;
  trashCount: number;
};

type TreeMutationResult = {
  tree: Array<DocumentTreeNode>;
  activeDocument: DocumentRecord | null;
  selectedFolderPath: string | null;
};

function getStorageRoot() {
  const configuredRoot = process.env.PIBO_STORAGE_DIR?.trim();

  if (!configuredRoot) {
    throw new Error(
      "Missing environment variable: PIBO_STORAGE_DIR. Configure a storage path outside the deployed app directory.",
    );
  }

  return path.resolve(process.cwd(), configuredRoot);
}

function getDocsRoot() {
  return path.join(getStorageRoot(), "docs");
}

function getTrashRoot() {
  return path.join(getStorageRoot(), "trash");
}

function getTrashItemsRoot() {
  return path.join(getTrashRoot(), "items");
}

function getTrashMetaRoot() {
  return path.join(getTrashRoot(), "meta");
}

function getUploadsRoot() {
  return path.join(getStorageRoot(), "uploads");
}

function normalizeSlashes(value: string) {
  return value.replaceAll("\\", "/");
}

function trimSeparators(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

function prettifyName(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replaceAll("_", "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return slug || "untitled";
}

function assertSafeRelativePath(relativePath: string) {
  const normalized = trimSeparators(normalizeSlashes(relativePath));
  if (!normalized) {
    return "";
  }

  const resolved = path.posix.normalize(normalized);
  if (
    resolved === "." ||
    resolved.startsWith("../") ||
    resolved.includes("/../") ||
    path.posix.isAbsolute(resolved)
  ) {
    throw new Error("Invalid path");
  }

  return resolved;
}

function documentPathToAbsolute(documentPath: string) {
  const safePath = assertSafeRelativePath(documentPath);
  return path.join(getDocsRoot(), `${safePath}.md`);
}

function directoryPathToAbsolute(directoryPath: string | null | undefined) {
  const safePath = assertSafeRelativePath(directoryPath ?? "");
  const docsRoot = getDocsRoot();
  return safePath ? path.join(docsRoot, safePath) : docsRoot;
}

function trashItemPathToAbsolute(trashPath: string) {
  const safePath = assertSafeRelativePath(trashPath);
  return path.join(getTrashItemsRoot(), safePath);
}

function trashMetaPathToAbsolute(id: string) {
  return path.join(getTrashMetaRoot(), `${id}.json`);
}

async function pathExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function createUniquePath(
  baseDirectory: string,
  baseSlug: string,
  extension = "",
  excludePath?: string,
) {
  let attempt = 0;

  for (;;) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidatePath = path.join(baseDirectory, `${baseSlug}${suffix}${extension}`);
    if (excludePath && path.resolve(candidatePath) === path.resolve(excludePath)) {
      return candidatePath;
    }
    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }
    attempt += 1;
  }
}

function getParentDirectory(documentPath: string | null | undefined) {
  if (!documentPath || !documentPath.includes("/")) {
    return null;
  }

  return documentPath.split("/").slice(0, -1).join("/");
}

function isWithinPath(candidatePath: string | null | undefined, parentPath: string) {
  if (!candidatePath) {
    return false;
  }

  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function replacePathPrefix(
  candidatePath: string | null | undefined,
  sourcePath: string,
  targetPath: string,
) {
  if (!candidatePath) {
    return null;
  }

  if (candidatePath === sourcePath) {
    return targetPath;
  }

  if (candidatePath.startsWith(`${sourcePath}/`)) {
    return `${targetPath}${candidatePath.slice(sourcePath.length)}`;
  }

  return candidatePath;
}

export async function ensureStorage() {
  const docsRoot = getDocsRoot();
  const trashItemsRoot = getTrashItemsRoot();
  const trashMetaRoot = getTrashMetaRoot();
  const uploadsRoot = getUploadsRoot();

  await mkdir(docsRoot, { recursive: true });
  await mkdir(trashItemsRoot, { recursive: true });
  await mkdir(trashMetaRoot, { recursive: true });
  await mkdir(uploadsRoot, { recursive: true });

  const rootEntries = await readdir(docsRoot);
  if (rootEntries.length > 0) {
    return;
  }

  await writeFile(
    path.join(docsRoot, "start-here.md"),
    `# Start Here

Willkommen in deinem dateisystembasierten Workspace.

- Diese Datei liegt im konfigurierten Storage unter \`docs/start-here.md\`
- Du kannst neue Dokumente und Ordner direkt aus der Oberfläche anlegen
- Aufgabenlisten funktionieren ebenfalls

## Beispiele

- [ ] Offene Aufgabe
- [x] Erledigte Aufgabe

> Zitate, Tabellen, Links, Bilder und Code-Blöcke sind im Editor aktiviert.
`,
    "utf8",
  );

  await mkdir(path.join(docsRoot, "journal"), { recursive: true });
  await writeFile(
    path.join(docsRoot, "journal", "daily-note.md"),
    `# Daily Note

## Heute

- Idee 1
- Idee 2

![Beispielbild](https://placehold.co/960x540?text=Bild)
`,
    "utf8",
  );
}

async function readTrashMetaFiles() {
  await ensureStorage();
  const entries = await readdir(getTrashMetaRoot(), { withFileTypes: true });
  const metaFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const filePath = path.join(getTrashMetaRoot(), entry.name);
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as TrashMetaRecord;
    });

  return Promise.all(metaFiles);
}

async function writeTrashMeta(meta: TrashMetaRecord) {
  await writeFile(trashMetaPathToAbsolute(meta.id), JSON.stringify(meta, null, 2), "utf8");
}

async function removeTrashMeta(id: string) {
  if (!(await pathExists(trashMetaPathToAbsolute(id)))) {
    return;
  }

  await rm(trashMetaPathToAbsolute(id), { force: true });
}

async function deleteTrashItem(meta: TrashMetaRecord) {
  await rm(trashItemPathToAbsolute(meta.trashPath), {
    recursive: true,
    force: true,
  });
  await removeTrashMeta(meta.id);
}

async function buildTree(
  directory: string,
  relativeDirectory = "",
): Promise<Array<DocumentTreeNode>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nodes = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".md")))
      .map(async (entry) => {
        if (entry.isDirectory()) {
          const nextRelative = trimSeparators(
            normalizeSlashes(path.posix.join(relativeDirectory, entry.name)),
          );
          return {
            kind: "directory" as const,
            name: prettifyName(entry.name),
            path: nextRelative,
            children: await buildTree(path.join(directory, entry.name), nextRelative),
          };
        }

        const documentName = entry.name.replace(/\.md$/i, "");
        const documentPath = trimSeparators(
          normalizeSlashes(path.posix.join(relativeDirectory, documentName)),
        );
        return {
          kind: "document" as const,
          name: prettifyName(documentName),
          path: documentPath,
        };
      }),
  );

  return nodes.toSorted((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, "de");
  });
}

async function purgeExpiredTrashItems() {
  const now = Date.now();
  const metas = await readTrashMetaFiles();

  await Promise.all(
    metas.filter((meta) => Date.parse(meta.purgeAfter) <= now).map((meta) => deleteTrashItem(meta)),
  );
}

export async function listDocumentTree() {
  await ensureStorage();
  await purgeExpiredTrashItems();
  return buildTree(getDocsRoot());
}

export async function listTrashItems(): Promise<Array<TrashItemRecord>> {
  await ensureStorage();
  await purgeExpiredTrashItems();

  const metas = await readTrashMetaFiles();
  return metas
    .map(({ trashPath: _trashPath, ...item }) => item)
    .toSorted((left, right) => Date.parse(right.deletedAt) - Date.parse(left.deletedAt));
}

export async function getTrashCount() {
  return (await listTrashItems()).length;
}

function findFirstDocument(nodes: Array<DocumentTreeNode>): string | null {
  for (const node of nodes) {
    if (node.kind === "document") {
      return node.path;
    }

    const nested = findFirstDocument(node.children ?? []);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export async function getDefaultDocumentPath() {
  const tree = await listDocumentTree();
  return findFirstDocument(tree);
}

export async function readDocument(documentPath: string): Promise<DocumentRecord> {
  await ensureStorage();

  const filePath = documentPathToAbsolute(documentPath);
  const fileStats = await stat(filePath);
  const markdown = await readFile(filePath, "utf8");

  return {
    path: assertSafeRelativePath(documentPath),
    name: prettifyName(path.basename(documentPath)),
    markdown,
    updatedAt: fileStats.mtime.toISOString(),
  };
}

export async function saveDocument(input: { documentPath: string; markdown: string }) {
  await ensureStorage();

  const filePath = documentPathToAbsolute(input.documentPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, input.markdown, "utf8");
  return readDocument(input.documentPath);
}

export async function createDocument(input: { parentPath?: string | null; name: string }) {
  await ensureStorage();

  const parentDirectory = directoryPathToAbsolute(input.parentPath);
  await mkdir(parentDirectory, { recursive: true });

  const targetPath = await createUniquePath(parentDirectory, slugify(input.name), ".md");
  const relativeDocumentPath = trimSeparators(
    normalizeSlashes(path.relative(getDocsRoot(), targetPath).replace(/\.md$/i, "")),
  );

  await writeFile(
    targetPath,
    `# ${input.name.trim() || "Untitled"}

`,
    "utf8",
  );

  return {
    document: await readDocument(relativeDocumentPath),
    tree: await listDocumentTree(),
  };
}

export async function createDirectory(input: { parentPath?: string | null; name: string }) {
  await ensureStorage();

  const parentDirectory = directoryPathToAbsolute(input.parentPath);
  await mkdir(parentDirectory, { recursive: true });

  const targetPath = await createUniquePath(parentDirectory, slugify(input.name));
  await mkdir(targetPath, { recursive: true });

  return {
    tree: await listDocumentTree(),
    path: trimSeparators(normalizeSlashes(path.relative(getDocsRoot(), targetPath))),
  };
}

async function buildDeleteResult(options?: {
  preferredDocumentPath?: string | null;
  preferredFolderPath?: string | null;
}): Promise<DeleteResult> {
  const tree = await listDocumentTree();
  const resolvedDocumentPath =
    options?.preferredDocumentPath &&
    (await pathExists(documentPathToAbsolute(options.preferredDocumentPath)))
      ? options.preferredDocumentPath
      : findFirstDocument(tree);

  return {
    tree,
    activeDocument: resolvedDocumentPath ? await readDocument(resolvedDocumentPath) : null,
    selectedFolderPath:
      options?.preferredFolderPath &&
      (await pathExists(directoryPathToAbsolute(options.preferredFolderPath)))
        ? options.preferredFolderPath
        : getParentDirectory(resolvedDocumentPath),
    trashCount: await getTrashCount(),
  };
}

async function buildTreeMutationResult(options?: {
  preferredDocumentPath?: string | null;
  preferredFolderPath?: string | null;
}): Promise<TreeMutationResult> {
  const tree = await listDocumentTree();
  const resolvedDocumentPath =
    options?.preferredDocumentPath &&
    (await pathExists(documentPathToAbsolute(options.preferredDocumentPath)))
      ? options.preferredDocumentPath
      : findFirstDocument(tree);

  return {
    tree,
    activeDocument: resolvedDocumentPath ? await readDocument(resolvedDocumentPath) : null,
    selectedFolderPath:
      options?.preferredFolderPath &&
      (await pathExists(directoryPathToAbsolute(options.preferredFolderPath)))
        ? options.preferredFolderPath
        : getParentDirectory(resolvedDocumentPath),
  };
}

async function moveItemToTrash(input: { kind: "directory" | "document"; targetPath: string }) {
  await ensureStorage();

  const safeTargetPath = assertSafeRelativePath(input.targetPath);
  const absoluteSourcePath =
    input.kind === "document"
      ? documentPathToAbsolute(safeTargetPath)
      : directoryPathToAbsolute(safeTargetPath);

  if (!(await pathExists(absoluteSourcePath))) {
    throw new Error("Element nicht gefunden");
  }

  const deletedAt = new Date();
  const metaId = randomUUID();
  const baseName = path.basename(absoluteSourcePath);
  const trashBucket = path.join(getTrashItemsRoot(), metaId);
  await mkdir(trashBucket, { recursive: true });

  const targetInTrash = await createUniquePath(
    trashBucket,
    slugify(baseName.replace(/\.md$/i, "")),
    input.kind === "document" ? ".md" : "",
  );

  await movePath(absoluteSourcePath, targetInTrash);

  const meta: TrashMetaRecord = {
    id: metaId,
    kind: input.kind,
    name: prettifyName(path.basename(safeTargetPath)),
    originalPath: safeTargetPath,
    deletedAt: deletedAt.toISOString(),
    purgeAfter: new Date(deletedAt.getTime() + MIN_TRASH_RETENTION_MS).toISOString(),
    trashPath: trimSeparators(normalizeSlashes(path.relative(getTrashItemsRoot(), targetInTrash))),
  };

  await writeTrashMeta(meta);
}

export async function deleteDocument(input: {
  documentPath: string;
  activeDocumentPath?: string | null;
  selectedFolderPath?: string | null;
}) {
  const documentPath = assertSafeRelativePath(input.documentPath);
  await moveItemToTrash({
    kind: "document",
    targetPath: documentPath,
  });

  const nextPreferredDocument =
    input.activeDocumentPath && input.activeDocumentPath === documentPath
      ? null
      : (input.activeDocumentPath ?? null);
  const nextPreferredFolder =
    input.selectedFolderPath && isWithinPath(input.selectedFolderPath, documentPath)
      ? null
      : (input.selectedFolderPath ?? getParentDirectory(nextPreferredDocument));

  return buildDeleteResult({
    preferredDocumentPath: nextPreferredDocument,
    preferredFolderPath: nextPreferredFolder,
  });
}

export async function deleteDirectory(input: {
  directoryPath: string;
  activeDocumentPath?: string | null;
  selectedFolderPath?: string | null;
}) {
  const directoryPath = assertSafeRelativePath(input.directoryPath);
  await moveItemToTrash({
    kind: "directory",
    targetPath: directoryPath,
  });

  const nextPreferredDocument =
    input.activeDocumentPath && isWithinPath(input.activeDocumentPath, directoryPath)
      ? null
      : (input.activeDocumentPath ?? null);
  const nextPreferredFolder =
    input.selectedFolderPath && isWithinPath(input.selectedFolderPath, directoryPath)
      ? getParentDirectory(directoryPath)
      : (input.selectedFolderPath ?? null);

  return buildDeleteResult({
    preferredDocumentPath: nextPreferredDocument,
    preferredFolderPath: nextPreferredFolder,
  });
}

export async function restoreTrashItem(input: { id: string }) {
  await ensureStorage();
  await purgeExpiredTrashItems();

  const meta = (await readTrashMetaFiles()).find((item) => item.id === input.id);
  if (!meta) {
    throw new Error("Papierkorb-Eintrag nicht gefunden");
  }

  const originalParent = getParentDirectory(meta.originalPath);
  const targetDirectory = directoryPathToAbsolute(originalParent);
  await mkdir(targetDirectory, { recursive: true });

  const sourcePath = trashItemPathToAbsolute(meta.trashPath);
  const targetBaseName =
    meta.kind === "document" ? path.basename(meta.originalPath) : path.basename(meta.originalPath);
  const targetPath = await createUniquePath(
    targetDirectory,
    slugify(targetBaseName),
    meta.kind === "document" ? ".md" : "",
  );

  await movePath(sourcePath, targetPath);
  await rm(path.dirname(sourcePath), { recursive: true, force: true });
  await removeTrashMeta(meta.id);

  const restoredPath = trimSeparators(
    normalizeSlashes(
      path.relative(
        getDocsRoot(),
        meta.kind === "document" ? targetPath.replace(/\.md$/i, "") : targetPath,
      ),
    ),
  );

  return {
    tree: await listDocumentTree(),
    restoredPath,
    activeDocument: meta.kind === "document" ? await readDocument(restoredPath) : null,
    trashCount: await getTrashCount(),
  };
}

export async function emptyTrash() {
  await ensureStorage();
  await purgeExpiredTrashItems();

  const items = await readTrashMetaFiles();
  await Promise.all(items.map((item) => deleteTrashItem(item)));

  return {
    items: [] as Array<TrashItemRecord>,
    trashCount: 0,
  };
}

export async function moveDocument(input: {
  documentPath: string;
  destinationDirectoryPath?: string | null;
  activeDocumentPath?: string | null;
  selectedFolderPath?: string | null;
}) {
  await ensureStorage();

  const documentPath = assertSafeRelativePath(input.documentPath);
  const destinationDirectoryPath = input.destinationDirectoryPath
    ? assertSafeRelativePath(input.destinationDirectoryPath)
    : null;
  const sourcePath = documentPathToAbsolute(documentPath);

  if (!(await pathExists(sourcePath))) {
    throw new Error("Note nicht gefunden");
  }

  if (getParentDirectory(documentPath) === destinationDirectoryPath) {
    return buildTreeMutationResult({
      preferredDocumentPath: input.activeDocumentPath ?? null,
      preferredFolderPath: input.selectedFolderPath ?? null,
    });
  }

  const destinationDirectory = directoryPathToAbsolute(destinationDirectoryPath);
  if (!(await pathExists(destinationDirectory))) {
    throw new Error("Zielordner nicht gefunden");
  }

  const targetPath = await createUniquePath(
    destinationDirectory,
    slugify(path.basename(documentPath)),
    ".md",
  );

  await movePath(sourcePath, targetPath);

  const movedDocumentPath = trimSeparators(
    normalizeSlashes(path.relative(getDocsRoot(), targetPath).replace(/\.md$/i, "")),
  );
  const preferredDocumentPath = replacePathPrefix(
    input.activeDocumentPath,
    documentPath,
    movedDocumentPath,
  );
  const preferredFolderPath =
    input.activeDocumentPath === documentPath
      ? getParentDirectory(movedDocumentPath)
      : (input.selectedFolderPath ?? null);

  return buildTreeMutationResult({
    preferredDocumentPath,
    preferredFolderPath,
  });
}

export async function moveDirectory(input: {
  directoryPath: string;
  destinationDirectoryPath?: string | null;
  activeDocumentPath?: string | null;
  selectedFolderPath?: string | null;
}) {
  await ensureStorage();

  const directoryPath = assertSafeRelativePath(input.directoryPath);
  const destinationDirectoryPath = input.destinationDirectoryPath
    ? assertSafeRelativePath(input.destinationDirectoryPath)
    : null;
  const sourcePath = directoryPathToAbsolute(directoryPath);

  if (!(await pathExists(sourcePath))) {
    throw new Error("Ordner nicht gefunden");
  }

  if (destinationDirectoryPath && isWithinPath(destinationDirectoryPath, directoryPath)) {
    throw new Error("Ein Ordner kann nicht in sich selbst verschoben werden");
  }

  if (getParentDirectory(directoryPath) === destinationDirectoryPath) {
    return buildTreeMutationResult({
      preferredDocumentPath: input.activeDocumentPath ?? null,
      preferredFolderPath: input.selectedFolderPath ?? null,
    });
  }

  const destinationDirectory = directoryPathToAbsolute(destinationDirectoryPath);
  if (!(await pathExists(destinationDirectory))) {
    throw new Error("Zielordner nicht gefunden");
  }

  const targetPath = await createUniquePath(
    destinationDirectory,
    slugify(path.basename(directoryPath)),
  );

  await movePath(sourcePath, targetPath);

  const movedDirectoryPath = trimSeparators(
    normalizeSlashes(path.relative(getDocsRoot(), targetPath)),
  );

  return buildTreeMutationResult({
    preferredDocumentPath: replacePathPrefix(
      input.activeDocumentPath,
      directoryPath,
      movedDirectoryPath,
    ),
    preferredFolderPath: replacePathPrefix(
      input.selectedFolderPath,
      directoryPath,
      movedDirectoryPath,
    ),
  });
}

export async function renameDocument(input: {
  documentPath: string;
  name: string;
  activeDocumentPath?: string | null;
  selectedFolderPath?: string | null;
}) {
  await ensureStorage();

  const documentPath = assertSafeRelativePath(input.documentPath);
  const sourcePath = documentPathToAbsolute(documentPath);
  if (!(await pathExists(sourcePath))) {
    throw new Error("Note nicht gefunden");
  }

  const targetPath = await createUniquePath(
    path.dirname(sourcePath),
    slugify(input.name),
    ".md",
    sourcePath,
  );

  if (path.resolve(targetPath) !== path.resolve(sourcePath)) {
    await movePath(sourcePath, targetPath);
  }

  const renamedDocumentPath = trimSeparators(
    normalizeSlashes(path.relative(getDocsRoot(), targetPath).replace(/\.md$/i, "")),
  );

  return buildTreeMutationResult({
    preferredDocumentPath: replacePathPrefix(
      input.activeDocumentPath,
      documentPath,
      renamedDocumentPath,
    ),
    preferredFolderPath: input.selectedFolderPath ?? getParentDirectory(renamedDocumentPath),
  });
}

export async function renameDirectory(input: {
  directoryPath: string;
  name: string;
  activeDocumentPath?: string | null;
  selectedFolderPath?: string | null;
}) {
  await ensureStorage();

  const directoryPath = assertSafeRelativePath(input.directoryPath);
  const sourcePath = directoryPathToAbsolute(directoryPath);
  if (!(await pathExists(sourcePath))) {
    throw new Error("Ordner nicht gefunden");
  }

  const targetPath = await createUniquePath(
    path.dirname(sourcePath),
    slugify(input.name),
    "",
    sourcePath,
  );

  if (path.resolve(targetPath) !== path.resolve(sourcePath)) {
    await movePath(sourcePath, targetPath);
  }

  const renamedDirectoryPath = trimSeparators(
    normalizeSlashes(path.relative(getDocsRoot(), targetPath)),
  );

  return buildTreeMutationResult({
    preferredDocumentPath: replacePathPrefix(
      input.activeDocumentPath,
      directoryPath,
      renamedDirectoryPath,
    ),
    preferredFolderPath: replacePathPrefix(
      input.selectedFolderPath,
      directoryPath,
      renamedDirectoryPath,
    ),
  });
}

export async function saveUpload(file: File) {
  await ensureStorage();

  const extensionFromName = path.extname(file.name).toLowerCase();
  const extension =
    extensionFromName && extensionFromName.length <= 10 ? extensionFromName : ".bin";
  const fileName = `${Date.now()}-${randomUUID()}${extension}`;
  const uploadsRoot = getUploadsRoot();
  const targetPath = path.join(uploadsRoot, fileName);
  const bytes = Buffer.from(await file.arrayBuffer());

  await writeFile(targetPath, bytes);

  return {
    url: `/media/uploads/${fileName}`,
    fileName,
  };
}

export async function readUpload(relativePath: string) {
  await ensureStorage();

  const safePath = assertSafeRelativePath(relativePath);
  const uploadsRoot = getUploadsRoot();
  const absolutePath = path.join(uploadsRoot, safePath);
  const resolvedUploadsPath = path.resolve(uploadsRoot);
  const resolvedAbsolutePath = path.resolve(absolutePath);

  if (!resolvedAbsolutePath.startsWith(resolvedUploadsPath)) {
    throw new Error("Invalid upload path");
  }

  const bytes = await readFile(absolutePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const contentType =
    extension === ".png"
      ? "image/png"
      : extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : extension === ".gif"
          ? "image/gif"
          : extension === ".webp"
            ? "image/webp"
            : extension === ".svg"
              ? "image/svg+xml"
              : "application/octet-stream";

  return {
    bytes,
    contentType,
  };
}
