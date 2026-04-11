import { createFileRoute } from "@tanstack/react-router";
import { getAuthenticatedUsername } from "#/lib/auth.server";
import { saveUpload } from "#/lib/content.server";

export const Route = createFileRoute("/api/uploads")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!getAuthenticatedUsername()) {
          return new Response("Unauthorized", { status: 401 });
        }

        const formData = await request.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) {
          return new Response("Missing file", { status: 400 });
        }

        const upload = await saveUpload(file);
        return Response.json(upload);
      },
    },
  },
});
