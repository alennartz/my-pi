import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export function writeAtomic(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { encoding: "utf8" });
  renameSync(tmp, path);
}
