import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredTempFiles,
  createStorageName,
  deleteTempFiles,
  ensureTempRoot,
  getTempPath,
  writeTempFile
} from "@/runtime/temp-files";

const created: string[] = [];

afterEach(async () => {
  await deleteTempFiles(created.splice(0));
});

describe("temporary files", () => {
  it("uses random safe filenames and deletes temporary files", async () => {
    await ensureTempRoot();
    const storageName = createStorageName("png");
    created.push(storageName);

    expect(storageName).toMatch(/^[a-f0-9-]{36}\.png$/i);
    const filePath = await writeTempFile(storageName, Buffer.from("ok"));
    expect(path.basename(filePath)).toBe(storageName);

    await deleteTempFiles([storageName]);
    await expect(fs.stat(getTempPath(storageName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid storage names", () => {
    expect(() => getTempPath("../x.png")).toThrow("Invalid storage name");
  });

  it("sweeps foreign files in the temp root without breaking", async () => {
    const root = await ensureTempRoot();
    const foreignFile = path.join(root, ".DS_Store");
    await fs.writeFile(foreignFile, "junk");
    const oldTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await fs.utimes(foreignFile, oldTime, oldTime);

    await expect(cleanupExpiredTempFiles()).resolves.toBeUndefined();
    await expect(fs.stat(foreignFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
