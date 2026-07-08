import fs from "node:fs/promises";
import path from "node:path";
import type { ExifToolRunner } from "./exiftool-runner";
import { defaultExifToolRunner, ExifToolError } from "./exiftool-runner";
import type { ToolRunner } from "./media-tool-runner";
import { defaultFfmpegRunner, defaultFfprobeRunner, MediaToolError } from "./media-tool-runner";
import { findSensitiveMetadataKeys, inspectImageMetadata, MetadataValidationError } from "./metadata-cleaner";

export type AudioCleanerStrategy = "exiftool-metadata" | "ffmpeg-stream-copy";

export type AudioCleanerOptions = {
  runner?: ExifToolRunner;
  ffmpegRunner?: ToolRunner;
  ffprobeRunner?: ToolRunner;
  timeoutMs?: number;
  allowStreamCopyFallback?: boolean;
};

// Only ISO/QuickTime-based audio is ExifTool-writable. MP3, FLAC, WAV, AIFF,
// OGG, and Opus require the FFmpeg stream-copy fallback.
const EXIFTOOL_WRITABLE_AUDIO_EXTENSIONS = new Set([".m4a", ".m4b"]);

export function buildAudioExifToolArgs(filePath: string) {
  // -all= does not touch MP4/M4A header timestamps; they must be zeroed explicitly.
  return [
    "-all=",
    "-CreateDate=",
    "-ModifyDate=",
    "-TrackCreateDate=",
    "-TrackModifyDate=",
    "-MediaCreateDate=",
    "-MediaModifyDate=",
    "-overwrite_original",
    filePath
  ];
}

export type AudioStream = {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
};

export type AudioProbe = {
  streams?: AudioStream[];
};

export function buildFfmpegAudioCopyArgs(inputPath: string, outputPath: string) {
  return [
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:a?",
    "-vn",
    "-dn",
    "-sn",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-c:a",
    "copy",
    "-bitexact",
    outputPath
  ];
}

export function buildAudioFfprobeArgs(filePath: string) {
  return [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,sample_rate,channels,channel_layout",
    "-of",
    "json",
    filePath
  ];
}

export async function inspectAudioStreams(filePath: string, options: AudioCleanerOptions = {}): Promise<AudioProbe> {
  const runner = options.ffprobeRunner ?? defaultFfprobeRunner;
  const { stdout } = await runner(buildAudioFfprobeArgs(filePath), { timeoutMs: options.timeoutMs ?? 30_000 });
  return JSON.parse(stdout) as AudioProbe;
}

function audioStreams(probe: AudioProbe) {
  return (probe.streams ?? []).filter((stream) => stream.codec_type === "audio");
}

function assertAudioProbeIsClean(original: AudioProbe, cleaned: AudioProbe) {
  const cleanedNonAudio = (cleaned.streams ?? []).filter((stream) => stream.codec_type !== "audio");
  if (cleanedNonAudio.length > 0) {
    throw new MetadataValidationError("Non-audio streams remained after audio cleaning.");
  }

  const originalAudio = audioStreams(original);
  const cleanedAudio = audioStreams(cleaned);
  if (originalAudio.length !== cleanedAudio.length) {
    throw new MetadataValidationError("Audio stream count changed during audio cleaning.");
  }

  originalAudio.forEach((stream, index) => {
    const cleanedStream = cleanedAudio[index] ?? {};
    for (const key of ["codec_type", "codec_name", "sample_rate", "channels", "channel_layout"] as const) {
      if (stream[key] !== undefined && cleanedStream[key] !== undefined && stream[key] !== cleanedStream[key]) {
        throw new MetadataValidationError("Audio stream properties changed during audio cleaning.");
      }
    }
  });
}

export async function inspectAudioMetadata(filePath: string, options: AudioCleanerOptions = {}) {
  return inspectImageMetadata(filePath, { runner: options.runner, timeoutMs: options.timeoutMs ?? 15_000 });
}

async function cleanWithExifTool(outputPath: string, options: AudioCleanerOptions) {
  const runner = options.runner ?? defaultExifToolRunner;
  await runner(buildAudioExifToolArgs(outputPath), { timeoutMs: options.timeoutMs ?? 30_000 });
}

async function cleanWithStreamCopy(inputPath: string, outputPath: string, options: AudioCleanerOptions) {
  const runner = options.ffmpegRunner ?? defaultFfmpegRunner;
  const temporaryOutputPath = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath)}.stream-copy.tmp${path.extname(outputPath)}`
  );
  try {
    await runner(buildFfmpegAudioCopyArgs(inputPath, temporaryOutputPath), { timeoutMs: options.timeoutMs ?? 120_000 });
    await fs.rename(temporaryOutputPath, outputPath);
  } catch (error) {
    await fs.unlink(temporaryOutputPath).catch(() => undefined);
    throw error;
  }
}

export async function cleanAudioMetadata(inputPath: string, outputPath: string, options: AudioCleanerOptions = {}) {
  await fs.copyFile(inputPath, outputPath);

  if (EXIFTOOL_WRITABLE_AUDIO_EXTENSIONS.has(path.extname(outputPath).toLowerCase())) {
    try {
      await cleanWithExifTool(outputPath, options);
      await validateCleanedAudio(inputPath, outputPath, options);
      return { outputPath, strategy: "exiftool-metadata" as const };
    } catch (error) {
      if (options.allowStreamCopyFallback === false) {
        throw error;
      }
    }
  }

  await cleanWithStreamCopy(inputPath, outputPath, options);
  await validateCleanedAudio(inputPath, outputPath, options);
  return { outputPath, strategy: "ffmpeg-stream-copy" as const };
}

export async function validateCleanedAudio(originalPath: string, cleanedPath: string, options: AudioCleanerOptions = {}) {
  try {
    const [original, cleaned, originalProbe, cleanedProbe] = await Promise.all([
      inspectAudioMetadata(originalPath, options),
      inspectAudioMetadata(cleanedPath, options),
      inspectAudioStreams(originalPath, options),
      inspectAudioStreams(cleanedPath, options)
    ]);
    const originalType = original["File:FileTypeExtension"] ?? original.FileTypeExtension;
    const cleanedType = cleaned["File:FileTypeExtension"] ?? cleaned.FileTypeExtension;
    // An ID3v2 header makes ExifTool report any stream (incl. bare AAC) as "mp3";
    // removing that wrapper flips the detected container to the real codec (aac).
    // That is a correct clean, not a format change, so skip the container-label
    // check when the original was ID3-wrapped. The audio codec itself is still
    // verified below by assertAudioProbeIsClean (stream-copy never transcodes).
    const originalHadId3 =
      original["File:ID3Size"] !== undefined || Object.keys(original).some((key) => key.startsWith("ID3"));
    if (
      !originalHadId3 &&
      originalType &&
      cleanedType &&
      String(originalType).toLowerCase() !== String(cleanedType).toLowerCase()
    ) {
      throw new MetadataValidationError("Audio format changed during cleaning.");
    }
    assertAudioProbeIsClean(originalProbe, cleanedProbe);
    const remainingSensitiveKeys = findSensitiveMetadataKeys(cleaned);
    if (remainingSensitiveKeys.length > 0) {
      throw new MetadataValidationError("Privacy metadata remained after audio cleaning.");
    }
    return { valid: true as const, original, cleaned };
  } catch (error) {
    if (error instanceof MetadataValidationError || error instanceof ExifToolError || error instanceof MediaToolError) {
      throw error;
    }
    throw new MetadataValidationError("Could not validate cleaned audio.");
  }
}
