import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const config = defineConfig({
  resolve: {
    alias: [
      {
        find: /^openclaw\/(.*)$/,
        replacement: path.resolve(__dirname, "../src/$1"),
      },
    ],
  },
  server: {
    watch: {
      ignored: ["**/storage/**"],
    },
    allowedHosts: ["pibo.schottech.de", "www.pibo.schottech.de"],
  },
  plugins: [
    devtools(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
