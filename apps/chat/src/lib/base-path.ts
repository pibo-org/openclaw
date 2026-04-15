const DEFAULT_CHAT_BASE_PATH = "/chat";

export function normalizeChatBasePath(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, "");
  return withoutSlashes ? `/${withoutSlashes}` : "";
}

export function getConfiguredChatBasePath(): string {
  return normalizeChatBasePath(import.meta.env.VITE_CHAT_BASE_PATH ?? DEFAULT_CHAT_BASE_PATH);
}

export function withChatBasePath(pathname: string, basePath = getConfiguredChatBasePath()): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const normalizedBasePath = normalizeChatBasePath(basePath);
  return normalizedBasePath ? `${normalizedBasePath}${normalizedPath}` : normalizedPath;
}

export function getChatAssetBase(): string {
  const basePath = getConfiguredChatBasePath();
  return basePath ? `${basePath}/` : "/";
}
