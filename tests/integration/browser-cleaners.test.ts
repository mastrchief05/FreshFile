import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanImageInBrowser } from "@/browser/client-image-cleaner";
import { cleanMediaInBrowser } from "@/browser/client-media-cleaner";
import { findSensitiveMetadataKeys, inspectImageMetadata } from "@/cleaners/metadata-cleaner";

// The browser cleaners have no ExifTool safety net at runtime, so this suite
// IS the safety net: real files get cleaned through the browser code paths
// and the output is re-inspected with ExifTool. Requires exiftool + ffmpeg +
// ImageMagick:
//   RUN_MEDIA_INTEGRATION=1 npm run test:integration
const runIntegration = process.env.RUN_MEDIA_INTEGRATION === "1";

function run(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${binary} failed: ${result.stderr}`);
  }
}

const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const magickPath = process.env.IMAGEMAGICK_PATH ?? "convert";
const exiftoolPath = process.env.EXIFTOOL_PATH ?? "exiftool";

describe.skipIf(!runIntegration)("browser cleaners vs ExifTool", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "freshfile-browser-"));
  });

  async function assertCleanByExiftool(bytes: Uint8Array, filename: string) {
    const outputPath = path.join(tempDir, filename);
    await fs.writeFile(outputPath, bytes);
    const meta = await inspectImageMetadata(outputPath);
    expect(findSensitiveMetadataKeys(meta)).toEqual([]);
  }

  it("browser-cleans an MP3 with ID3 tags to ExifTool-clean output", async () => {
    const original = path.join(tempDir, "src.mp3");
    run(ffmpegPath, [
      "-v", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-metadata", "artist=Secret Artist", "-metadata", "title=Secret Song",
      "-metadata", "comment=private note",
      "-write_id3v1", "1",
      "-y", original
    ]);

    const bytes = new Uint8Array(await fs.readFile(original));
    const result = cleanMediaInBrowser(bytes, "src.mp3");
    expect(result.removed).toContain("id3");
    await assertCleanByExiftool(result.bytes, "browser-clean.mp3");
  });

  it("browser-cleans a FLAC with tags to ExifTool-clean output", async () => {
    const original = path.join(tempDir, "src.flac");
    run(ffmpegPath, [
      "-v", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-metadata", "artist=Secret Artist", "-metadata", "title=Secret Song",
      "-y", original
    ]);

    const bytes = new Uint8Array(await fs.readFile(original));
    const result = cleanMediaInBrowser(bytes, "src.flac");
    expect(result.removed).toContain("vorbisComment");
    await assertCleanByExiftool(result.bytes, "browser-clean.flac");
  });

  it("browser-cleans a GIF with comment and XMP to ExifTool-clean output", async () => {
    const original = path.join(tempDir, "src.gif");
    run(magickPath, ["-size", "8x8", "xc:red", "-comment", "secret comment", original]);
    run(exiftoolPath, ["-q", "-overwrite_original", "-XMP:Creator=Secret Person", original]);

    const bytes = new Uint8Array(await fs.readFile(original));
    const result = cleanMediaInBrowser(bytes, "src.gif");
    expect(result.removed.length).toBeGreaterThan(0);
    await assertCleanByExiftool(result.bytes, "browser-clean.gif");
  });

  it("browser-cleans a JPEG with GPS to ExifTool-clean output", async () => {
    const original = path.join(tempDir, "src.jpg");
    run(magickPath, ["-size", "8x8", "xc:teal", original]);
    run(exiftoolPath, [
      "-q", "-overwrite_original",
      "-GPSLatitude=48.1", "-GPSLatitudeRef=N", "-Artist=Secret", "-Software=SmokeTest",
      original
    ]);

    const bytes = new Uint8Array(await fs.readFile(original));
    const result = cleanImageInBrowser(bytes);
    expect(result.kind).toBe("jpeg");
    await assertCleanByExiftool(result.cleaned, "browser-clean.jpg");
  });
});
