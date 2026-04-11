export type DocumentTreeNode = {
  kind: "directory" | "document";
  name: string;
  path: string;
  children?: Array<DocumentTreeNode>;
};

export type DocumentRecord = {
  path: string;
  name: string;
  markdown: string;
  updatedAt: string;
};

export type TrashItemRecord = {
  id: string;
  kind: "directory" | "document";
  name: string;
  originalPath: string;
  deletedAt: string;
  purgeAfter: string;
};

export type AppBootstrapData = {
  authenticated: boolean;
  username: string | null;
  tree: Array<DocumentTreeNode>;
  activeDocument: DocumentRecord | null;
  trashCount: number;
};
