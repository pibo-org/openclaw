import { createFileRoute } from "@tanstack/react-router";
import { getAuthenticatedUsername } from "#/lib/auth.server";
import { saveDocument } from "#/lib/content.server";

function validatePath(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid path");
  }

  return value.trim();
}

export const Route = createFileRoute("/api/documents/save")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!getAuthenticatedUsername()) {
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: unknown;

        try {
          payload = await request.json();
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        if (!payload || typeof payload !== "object") {
          return new Response("Invalid payload", { status: 400 });
        }

        const path = validatePath((payload as { path?: unknown }).path);
        const markdown = (payload as { markdown?: unknown }).markdown;

        if (typeof markdown !== "string") {
          return new Response("Invalid markdown", { status: 400 });
        }

        const document = await saveDocument({
          documentPath: path,
          markdown,
        });

        return Response.json({
          path: document.path,
          updatedAt: document.updatedAt,
        });
      },
    },
  },
});
