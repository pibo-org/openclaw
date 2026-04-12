import { promises as fs } from "node:fs";
import path from "node:path";

export type PiboDelegateOrigin = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

export type PiboDelegateRecord = {
  delegateId: string;
  ownerAgentId?: string;
  ownerSessionKey: string;
  targetAgentId: string;
  childSessionKey: string;
  label?: string;
  originalTask: string;
  origin?: PiboDelegateOrigin;
  createdAt: string;
  updatedAt: string;
  start: {
    runId?: string;
    status: string;
  };
  lastContinue?: {
    runId?: string;
    status: string;
    message: string;
    updatedAt: string;
  };
};

function normalizeId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("delegateId required");
  }
  return trimmed;
}

export function piboDelegatesDir(stateDir: string): string {
  return path.join(stateDir, "pibo", "delegates");
}

export function piboDelegatePath(stateDir: string, delegateId: string): string {
  return path.join(piboDelegatesDir(stateDir), `${normalizeId(delegateId)}.json`);
}

export async function writePiboDelegateRecord(
  stateDir: string,
  record: PiboDelegateRecord,
): Promise<void> {
  await fs.mkdir(piboDelegatesDir(stateDir), { recursive: true });
  await fs.writeFile(
    piboDelegatePath(stateDir, record.delegateId),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export async function readPiboDelegateRecord(
  stateDir: string,
  delegateId: string,
): Promise<PiboDelegateRecord | null> {
  try {
    const raw = await fs.readFile(piboDelegatePath(stateDir, delegateId), "utf8");
    return JSON.parse(raw) as PiboDelegateRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
