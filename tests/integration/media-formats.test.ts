import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanAudioMetadata, validateCleanedAudio } from "@/audio-cleaner";
import { cleanVideoMetadata, validateCleanedVideo } from "@/video-cleaner";

// Runs only when explicitly requested and requires exiftool, ffmpeg, and ffprobe:
//   RUN_MEDIA_INTEGRATION=1 npm test
const runIntegration = process.env.RUN_MEDIA_INTEGRATION === "1";

function ffmpeg(args: string[]) {
  const result = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr}`);
  }
}

describe.skipIf(!runIntegration)("media integration formats", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "freshfile-media-"));
  });

  it("cleans MP4 metadata and header dates while preserving streams", async () => {
    const original = path.join(tempDir, "src.mp4");
    const cleaned = path.join(tempDir, "cleaned.mp4");
    ffmpeg([
      "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-metadata", "title=Secret", "-metadata", "comment=private",
      "-y", original
    ]);

    await cleanVideoMetadata(original, cleaned);
    await expect(validateCleanedVideo(original, cleaned)).resolves.toMatchObject({ valid: true });
  });

  it("cleans MKV metadata via FFmpeg stream copy", async () => {
    const source = path.join(tempDir, "src2.mp4");
    const original = path.join(tempDir, "src.mkv");
    const cleaned = path.join(tempDir, "cleaned.mkv");
    ffmpeg([
      "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", source
    ]);
    ffmpeg(["-i", source, "-c", "copy", "-metadata", "title=Secret", "-y", original]);

    const result = await cleanVideoMetadata(original, cleaned);
    expect(result.strategy).toBe("ffmpeg-stream-copy");
    await expect(validateCleanedVideo(original, cleaned)).resolves.toMatchObject({ valid: true });
  });

  it("cleans MP3 metadata via FFmpeg stream copy", async () => {
    const original = path.join(tempDir, "src.mp3");
    const cleaned = path.join(tempDir, "cleaned.mp3");
    ffmpeg([
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-metadata", "title=Secret", "-metadata", "artist=Private Artist",
      "-y", original
    ]);

    const result = await cleanAudioMetadata(original, cleaned);
    expect(result.strategy).toBe("ffmpeg-stream-copy");
    await expect(validateCleanedAudio(original, cleaned)).resolves.toMatchObject({ valid: true });
  });

  it("cleans FLAC and WAV metadata via FFmpeg stream copy", async () => {
    for (const extension of ["flac", "wav"]) {
      const original = path.join(tempDir, `src.${extension}`);
      const cleaned = path.join(tempDir, `cleaned.${extension}`);
      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-metadata", "title=Secret", "-y", original]);

      const result = await cleanAudioMetadata(original, cleaned);
      expect(result.strategy).toBe("ffmpeg-stream-copy");
      await expect(validateCleanedAudio(original, cleaned)).resolves.toMatchObject({ valid: true });
    }
  });
});
