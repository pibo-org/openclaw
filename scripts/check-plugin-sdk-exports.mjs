#!/usr/bin/env node

/**
 * Verifies that the root plugin-sdk runtime surface is present in the compiled
 * dist output.
 *
 * Run after `pnpm build` to catch missing root exports or leaked repo-only type
 * aliases before release.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginSdkSubpaths } from "./lib/plugin-sdk-entries.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = resolve(__dirname, "..", "dist", "plugin-sdk", "index.js");
const generatedFacadeTypeMapDts = resolve(
  __dirname,
  "..",
  "dist",
  "plugin-sdk",
  "src",
  "generated",
  "plugin-sdk-facade-type-map.generated.d.ts",
);
const pluginSdkDistRoot = resolve(__dirname, "..", "dist", "plugin-sdk");

function collectFiles(rootDir, predicate) {
  const results = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function candidateDeclarationTargets(specifier, importerPath) {
  const base = resolve(dirname(importerPath), specifier);
  const extension = extname(base);
  if (
    extension === ".js" ||
    extension === ".mjs" ||
    extension === ".cjs" ||
    extension === ".ts" ||
    extension === ".mts" ||
    extension === ".cts"
  ) {
    return [`${base.slice(0, -extension.length)}.d.ts`];
  }
  if (extension === ".d.ts") {
    return [base];
  }
  return [`${base}.d.ts`, join(base, "index.d.ts")];
}

function collectMissingRelativeDeclarationTargets() {
  const declarationFiles = collectFiles(pluginSdkDistRoot, (filePath) =>
    filePath.endsWith(".d.ts"),
  );
  const missing = [];
  for (const filePath of declarationFiles) {
    const content = readFileSync(filePath, "utf-8");
    const matches = content.matchAll(/from\s+"(\.{1,2}\/[^"]+)"|from\s+'(\.{1,2}\/[^']+)'/g);
    for (const match of matches) {
      const specifier = match[1] ?? match[2];
      if (!specifier) {
        continue;
      }
      const candidates = candidateDeclarationTargets(specifier, filePath);
      if (candidates.some((candidate) => existsSync(candidate))) {
        continue;
      }
      missing.push({
        importer: filePath,
        specifier,
        expected: candidates,
      });
    }
  }
  return missing;
}
if (!existsSync(distFile)) {
  console.error("ERROR: dist/plugin-sdk/index.js not found. Run `pnpm build` first.");
  process.exit(1);
}

const content = readFileSync(distFile, "utf-8");

// Extract the final export statement from the compiled output.
// tsdown/rolldown emits a single `export { ... }` at the end of the file.
const exportMatch = content.match(/export\s*\{([^}]+)\}\s*;?\s*$/);
if (!exportMatch) {
  console.error("ERROR: Could not find export statement in dist/plugin-sdk/index.js");
  process.exit(1);
}

const exportedNames = exportMatch[1]
  .split(",")
  .map((s) => {
    // Handle `foo as bar` aliases — the exported name is the `bar` part
    const parts = s.trim().split(/\s+as\s+/);
    return (parts[parts.length - 1] || "").trim();
  })
  .filter(Boolean);

const exportSet = new Set(exportedNames);

const requiredRuntimeShimEntries = ["compat.js", "root-alias.cjs"];

// The root plugin-sdk entry intentionally stays tiny. Keep this list aligned
// with src/plugin-sdk/index.ts runtime exports.
const requiredExports = [
  "emptyPluginConfigSchema",
  "onDiagnosticEvent",
  "registerContextEngine",
  "delegateCompactionToRuntime",
];

let missing = 0;
for (const name of requiredExports) {
  if (!exportSet.has(name)) {
    console.error(`MISSING EXPORT: ${name}`);
    missing += 1;
  }
}

for (const entry of pluginSdkSubpaths) {
  const jsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.js`);
  const dtsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.d.ts`);
  if (!existsSync(jsPath)) {
    console.error(`MISSING SUBPATH JS: dist/plugin-sdk/${entry}.js`);
    missing += 1;
  }
  if (!existsSync(dtsPath)) {
    console.error(`MISSING SUBPATH DTS: dist/plugin-sdk/${entry}.d.ts`);
    missing += 1;
  }
}

for (const entry of requiredRuntimeShimEntries) {
  const shimPath = resolve(__dirname, "..", "dist", "plugin-sdk", entry);
  if (!existsSync(shimPath)) {
    console.error(`MISSING RUNTIME SHIM: dist/plugin-sdk/${entry}`);
    missing += 1;
  }
}

if (!existsSync(generatedFacadeTypeMapDts)) {
  console.error(
    "MISSING GENERATED FACADE TYPE MAP DTS: dist/plugin-sdk/src/generated/plugin-sdk-facade-type-map.generated.d.ts",
  );
  missing += 1;
} else {
  const facadeTypeMapContent = readFileSync(generatedFacadeTypeMapDts, "utf-8");
  if (facadeTypeMapContent.includes("@openclaw/")) {
    console.error(
      "INVALID GENERATED FACADE TYPE MAP DTS: dist/plugin-sdk/src/generated/plugin-sdk-facade-type-map.generated.d.ts leaks @openclaw/* imports",
    );
    missing += 1;
  }
}

const missingRelativeDeclarationTargets = collectMissingRelativeDeclarationTargets();
for (const item of missingRelativeDeclarationTargets) {
  const importer = item.importer.replace(`${pluginSdkDistRoot}/`, "dist/plugin-sdk/");
  console.error(
    `MISSING DECLARATION TARGET: ${importer} -> ${item.specifier} (expected ${item.expected
      .map((candidate) => candidate.replace(`${pluginSdkDistRoot}/`, "dist/plugin-sdk/"))
      .join(" or ")})`,
  );
  missing += 1;
}
if (missing > 0) {
  console.error(
    `\nERROR: ${missing} required plugin-sdk artifact(s) missing (named exports or subpath files).`,
  );
  console.error("This will break published plugin-sdk artifacts.");
  console.error(
    "Check src/plugin-sdk/index.ts, generated d.ts rewrites, subpath entries, and rebuild.",
  );
  process.exit(1);
}

console.log(`OK: All ${requiredExports.length} required plugin-sdk exports verified.`);
