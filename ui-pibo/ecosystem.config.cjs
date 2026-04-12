const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, ".env");
const envContent = fs.readFileSync(envPath, "utf8");
const envVars = {};
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      envVars[key] = val;
    }
  }
}

module.exports = {
  apps: [
    {
      name: "pibo-app",
      script: "server-prod.mjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        PIBO_STORAGE_DIR: "/var/lib/pibo-webapp/storage",
        ...envVars,
      },
    },
  ],
};
