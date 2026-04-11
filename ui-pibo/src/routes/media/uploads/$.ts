import { createFileRoute } from "@tanstack/react-router";
import { getAuthenticatedUsername } from "#/lib/auth.server";
import { readUpload } from "#/lib/content.server";

export const Route = createFileRoute("/media/uploads/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!getAuthenticatedUsername()) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          const asset = await readUpload(params._splat);
          return new Response(asset.bytes, {
            headers: {
              "Content-Type": asset.contentType,
              "Cache-Control": "private, max-age=31536000, immutable",
            },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      },
    },
  },
});
