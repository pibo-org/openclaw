export type PiboModuleStatus = "live" | "preview";

export type PiboModule = {
  id: string;
  title: string;
  href: string;
  description: string;
  status: PiboModuleStatus;
  runtime: string;
};

export const PIBO_MODULES: PiboModule[] = [
  {
    id: "editor",
    title: "Markdown-Editor",
    href: "/editor",
    description: "Dateisystembasierter Workspace fuer Dokumente, Uploads und Live-Sync.",
    status: "live",
    runtime: "ui-pibo",
  },
  {
    id: "workflows",
    title: "Workflows Dashboard",
    href: "/workflows",
    description: "Read-only Dashboard fuer Workflow-Runs, Trace-Summaries, Events und Artefakte.",
    status: "live",
    runtime: "ui-pibo",
  },
  {
    id: "chat",
    title: "OpenClaw-Chat",
    href: "/chat",
    description: "Chat-Oberflaeche auf derselben Hauptdomain mit eigenem Gateway-Namespace.",
    status: "live",
    runtime: "apps/chat",
  },
];
