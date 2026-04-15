import { getWorkflowModuleManifest, listWorkflowModuleManifests } from "./modules/manifests.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printJson(payload: unknown) {
  console.log(JSON.stringify(payload, null, 2));
}

function printModuleSummary(modules: ReturnType<typeof listWorkflowModuleManifests>) {
  for (const module of modules) {
    console.log(`- ${module.moduleId}: ${module.description}`);
  }
}

function terminalStatesText(states: string[]) {
  return states.join(", ");
}

export function workflowsList(opts: { json?: boolean }) {
  const modules = listWorkflowModuleManifests();
  if (opts.json) {
    printJson({ modules });
    return;
  }
  if (modules.length === 0) {
    console.log("Keine Workflow-Module registriert.");
    return;
  }
  printModuleSummary(modules);
}

export function workflowsDescribe(moduleId: string, opts: { json?: boolean }) {
  const manifest = getWorkflowModuleManifest(moduleId);
  if (!manifest) {
    fail(`Workflow-Modul nicht gefunden: ${moduleId}`);
  }
  if (opts.json) {
    printJson(manifest);
    return;
  }

  console.log(`Module: ${manifest.moduleId}`);
  console.log(`Name: ${manifest.displayName}`);
  console.log(`Beschreibung: ${manifest.description}`);
  console.log(`Kind: ${manifest.kind}`);
  console.log(`Version: ${manifest.version}`);
  console.log(
    `Required agents: ${manifest.requiredAgents.length ? manifest.requiredAgents.join(", ") : "none"}`,
  );
  console.log(`Supports abort: ${manifest.supportsAbort ? "yes" : "no"}`);
  console.log(`Terminal states: ${terminalStatesText(manifest.terminalStates)}`);
  console.log("Input schema summary:");
  for (const line of manifest.inputSchemaSummary) {
    console.log(`- ${line}`);
  }
  console.log("Artifact contract:");
  for (const line of manifest.artifactContract) {
    console.log(`- ${line}`);
  }
}
