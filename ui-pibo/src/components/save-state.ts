import { useSyncExternalStore } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

let currentSaveState: SaveState = "idle";
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => {
    listener();
  });
}

export function getSaveState() {
  return currentSaveState;
}

export function setSaveState(nextState: SaveState) {
  if (currentSaveState === nextState) {
    return;
  }

  currentSaveState = nextState;
  emit();
}

export function resetSaveState() {
  setSaveState("idle");
}

export function subscribeToSaveState(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function useSaveState() {
  return useSyncExternalStore(subscribeToSaveState, getSaveState, getSaveState);
}
