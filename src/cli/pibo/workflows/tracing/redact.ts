const SECRET_KEY_RE =
  /(authorization|api[_-]?key|cookie|password|passwd|secret|session|token|credential)/i;

function truncateString(value: string, maxStringLength: number): string {
  if (value.length <= maxStringLength) {
    return value;
  }
  return `${value.slice(0, maxStringLength)}... [truncated ${value.length - maxStringLength} chars]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function redactTraceValue(
  value: unknown,
  opts?: { keyPath?: string[]; maxStringLength?: number },
): unknown {
  const keyPath = opts?.keyPath ?? [];
  const maxStringLength = opts?.maxStringLength ?? 4_000;
  const currentKey = keyPath.at(-1) ?? "";

  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (SECRET_KEY_RE.test(currentKey)) {
      return value ? "[REDACTED]" : value;
    }
    return truncateString(value, maxStringLength);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactTraceValue(entry, { keyPath, maxStringLength }));
  }
  if (Buffer.isBuffer(value)) {
    return `[binary:${value.byteLength} bytes]`;
  }
  if (!isPlainObject(value)) {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "symbol") {
      return value.toString();
    }
    if (typeof value === "function") {
      return "[function]";
    }
    return Object.prototype.toString.call(value);
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      output[key] = entry == null || entry === "" ? entry : "[REDACTED]";
      continue;
    }
    output[key] = redactTraceValue(entry, {
      keyPath: [...keyPath, key],
      maxStringLength,
    });
  }
  return output;
}
