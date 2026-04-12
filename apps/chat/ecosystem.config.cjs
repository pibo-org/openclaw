const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, ".env");
const envVars = {};

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
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
}

module.exports = {
  apps: [{
    name: "pibo-chat",
    script: "server-prod.mjs",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    max_memory_restart: "600M",
    env: {
      NODE_ENV: "production",
      PORT: 3010,
      ...envVars,
    }
  }]
};
