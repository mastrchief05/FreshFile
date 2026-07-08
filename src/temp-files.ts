import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getTempFileTtlMinutes } from "./config";

const TEMP_ROOT = process.env.FRESHFILE_TEMP_DIR ?? path.join(os.tmpdir(), "freshfile");

export function getTempRoot() {
  return TEMP_ROOT;
}

export async function ensureTempRoot() {
  await fs.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  return TEMP_ROOT;
}

export function createStorageName(extension: string) {
  const safeExtension = extension.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${randomUUID()}.${safeExtension}`;
}

export function getTempPath(storageName: string) {
  if (!/^[a-f0-9-]{36}\.[a-z0-9]+$/i.test(storageName)) {
    throw new Error("Invalid storage name.");
  }

  const resolved = path.resolve(TEMP_ROOT, storageName);
  const root = path.resolve(TEMP_ROOT);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid storage path.");
  }

  return resolved;
}

export async function writeTempFile(storageName: string, buffer: Buffer) {
  await ensureTempRoot();
  const filePath = getTempPath(storageName);
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

export async function deleteTempFile(storageName?: string) {
  if (!storageName) return;
  try {
    await fs.unlink(getTempPath(storageName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function deleteTempFiles(storageNames: Array<string | undefined>) {
  await Promise.all(storageNames.map((storageName) => deleteTempFile(storageName)));
}

export async function cleanupExpiredTempFiles(ttlMinutes?: number) {
  await ensureTempRoot();
  const ttlMs = getTempFileTtlMinutes(ttlMinutes) * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  const entries = await fs.readdir(TEMP_ROOT, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        try {
          // Sweep every file in the dedicated temp root, including leftovers that
          // do not match the storage-name pattern (crashed stream-copy temp files,
          // editor/OS droppings). readdir names contain no path separators.
          const filePath = path.join(TEMP_ROOT, entry.name);
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(filePath);
          }
        } catch {
          // A failed stat/unlink (e.g. concurrent sweep) must never block uploads.
        }
      })
  );
}
