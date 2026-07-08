import fs from "node:fs/promises";
import path from "node:path";
import type { ExifToolRunner } from "./exiftool-runner";
import { defaultExifToolRunner, ExifToolError } from "./exiftool-runner";
import type { ToolRunner } from "./media-tool-runner";
import { defaultFfmpegRunner, defaultFfprobeRunner, MediaToolError } from "./media-tool-runner";
import { findSensitiveMetadataKeys, inspectImageMetadata } from "./metadata-cleaner";

export type VideoCleanerStrategy = "exiftool-metadata" | "ffmpeg-stream-copy";

export type VideoCleanerOptions = {
  exifToolRunner?: ExifToolRunner;
  ffmpegRunner?: ToolRunner;
  ffprobeRunner?: ToolRunner;
  timeoutMs?: number;
  allowStreamCopyFallback?: boolean;
};

export type VideoStream = {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  display_aspect_ratio?: string;
  field_order?: string;
  tags?: Record<string, string>;
};

export type VideoProbe = {
  streams?: VideoStream[];
  format?: {
    format_name?: string;
    duration?: string;
    tags?: Record<string, string>;
  };
};

export class VideoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoValidationError";
  }
}

export function buildVideoExifToolArgs(filePath: string) {
  // -all= does not touch MP4/MOV header timestamps; they must be zeroed explicitly.
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

export function buildFfmpegStreamCopyArgs(inputPath: string, outputPath: string) {
  // Only video, audio, and subtitle streams are playback content. Data tracks
  // (e.g. SMPTE timecode) and attachments are production metadata and are
  // dropped — some of them (tmcd) cannot even be remuxed into MP4.
  const args = [
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-map",
    "0:s?",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-c",
    "copy",
    "-bitexact"
  ];
  const outputExtension = path.extname(outputPath).toLowerCase();
  if ([".mp4", ".m4v", ".mov", ".qt", ".3gp", ".3gpp", ".m4a", ".m4b"].includes(outputExtension)) {
    args.push("-movflags", "use_metadata_tags");
  }
  args.push(outputPath);
  return args;
}

export function buildFfprobeArgs(filePath: string) {
  return [
    "-v",
    "error",
    "-show_entries",
    "format=format_name,duration:format_tags:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,channel_layout,pix_fmt,color_range,color_space,color_transfer,color_primaries,display_aspect_ratio,field_order:stream_tags",
    "-of",
    "json",
    filePath
  ];
}

export async function inspectVideoMetadata(filePath: string, options: VideoCleanerOptions = {}) {
  return inspectImageMetadata(filePath, { runner: options.exifToolRunner, timeoutMs: options.timeoutMs ?? 15_000 });
}

export async function inspectVideoStreams(filePath: string, options: VideoCleanerOptions = {}): Promise<VideoProbe> {
  const runner = options.ffprobeRunner ?? defaultFfprobeRunner;
  const { stdout } = await runner(buildFfprobeArgs(filePath), { timeoutMs: options.timeoutMs ?? 30_000 });
  return JSON.parse(stdout) as VideoProbe;
}

function durationSeconds(probe: VideoProbe) {
  const value = Number.parseFloat(probe.format?.duration ?? "");
  return Number.isFinite(value) ? value : undefined;
}

function streamsByType(probe: VideoProbe, type: string) {
  return (probe.streams ?? []).filter((stream) => stream.codec_type === type);
}

function assertEqual<T>(label: string, original: T, cleaned: T) {
  if (original !== undefined && cleaned !== undefined && original !== cleaned) {
    throw new VideoValidationError(`${label} changed during video cleaning.`);
  }
}

function compareStream(original: VideoStream, cleaned: VideoStream, index: number) {
  assertEqual(`Stream ${index} codec type`, original.codec_type, cleaned.codec_type);
  assertEqual(`Stream ${index} codec`, original.codec_name, cleaned.codec_name);
  assertEqual(`Stream ${index} width`, original.width, cleaned.width);
  assertEqual(`Stream ${index} height`, original.height, cleaned.height);
  assertEqual(`Stream ${index} frame rate`, original.avg_frame_rate, cleaned.avg_frame_rate);
  assertEqual(`Stream ${index} sample rate`, original.sample_rate, cleaned.sample_rate);
  assertEqual(`Stream ${index} channels`, original.channels, cleaned.channels);
  assertEqual(`Stream ${index} pixel format`, original.pix_fmt, cleaned.pix_fmt);
  assertEqual(`Stream ${index} color range`, original.color_range, cleaned.color_range);
  assertEqual(`Stream ${index} color space`, original.color_space, cleaned.color_space);
  assertEqual(`Stream ${index} color transfer`, original.color_transfer, cleaned.color_transfer);
  assertEqual(`Stream ${index} color primaries`, original.color_primaries, cleaned.color_primaries);
  assertEqual(`Stream ${index} display aspect ratio`, original.display_aspect_ratio, cleaned.display_aspect_ratio);
}

export function validateVideoProbeSnapshots(original: VideoProbe, cleaned: VideoProbe) {
  // Playback streams (video/audio/subtitle) must survive unchanged. Data and
  // attachment tracks are metadata and may be dropped by the cleaner.
  for (const type of ["video", "audio", "subtitle"]) {
    const originalStreams = streamsByType(original, type);
    const cleanedStreams = streamsByType(cleaned, type);
    if (originalStreams.length !== cleanedStreams.length) {
      throw new VideoValidationError(`${type} stream count changed during video cleaning.`);
    }
    originalStreams.forEach((stream, index) => compareStream(stream, cleanedStreams[index] ?? {}, index));
  }

  const originalDuration = durationSeconds(original);
  const cleanedDuration = durationSeconds(cleaned);
  if (originalDuration !== undefined && cleanedDuration !== undefined) {
    const tolerance = Math.max(1, originalDuration * 0.01);
    if (Math.abs(originalDuration - cleanedDuration) > tolerance) {
      throw new VideoValidationError("Duration changed beyond tolerance during video cleaning.");
    }
  }

  return { valid: true as const, original, cleaned };
}

export async function validateCleanedVideo(originalPath: string, cleanedPath: string, options: VideoCleanerOptions = {}) {
  try {
    const [originalProbe, cleanedProbe, cleanedMetadata] = await Promise.all([
      inspectVideoStreams(originalPath, options),
      inspectVideoStreams(cleanedPath, options),
      inspectVideoMetadata(cleanedPath, options)
    ]);
    const probeResult = validateVideoProbeSnapshots(originalProbe, cleanedProbe);
    const remainingSensitiveKeys = findSensitiveMetadataKeys(cleanedMetadata);
    if (remainingSensitiveKeys.length > 0) {
      throw new VideoValidationError("Privacy metadata remained after video cleaning.");
    }
    return probeResult;
  } catch (error) {
    if (error instanceof VideoValidationError || error instanceof MediaToolError || error instanceof ExifToolError) {
      throw error;
    }
    throw new VideoValidationError("Could not validate cleaned video.");
  }
}

async function cleanWithExifTool(outputPath: string, options: VideoCleanerOptions) {
  const runner = options.exifToolRunner ?? defaultExifToolRunner;
  await runner(buildVideoExifToolArgs(outputPath), { timeoutMs: options.timeoutMs ?? 30_000 });
}

async function cleanWithStreamCopy(inputPath: string, outputPath: string, options: VideoCleanerOptions) {
  const runner = options.ffmpegRunner ?? defaultFfmpegRunner;
  const temporaryOutputPath = path.join(path.dirname(outputPath), `${path.basename(outputPath)}.stream-copy.tmp${path.extname(outputPath)}`);
  try {
    await runner(buildFfmpegStreamCopyArgs(inputPath, temporaryOutputPath), { timeoutMs: options.timeoutMs ?? 120_000 });
    // ExifTool can only post-process ISO/QuickTime containers; Matroska, AVI, and
    // MPEG are not ExifTool-writable and already leave the remux without metadata.
    if ([".mp4", ".m4v", ".mov", ".qt", ".3gp", ".3gpp", ".m4a", ".m4b"].includes(path.extname(outputPath).toLowerCase())) {
      await cleanWithExifTool(temporaryOutputPath, options);
    }
    await fs.rename(temporaryOutputPath, outputPath);
  } catch (error) {
    await fs.unlink(temporaryOutputPath).catch(() => undefined);
    throw error;
  }
}

export async function cleanVideoMetadata(inputPath: string, outputPath: string, options: VideoCleanerOptions = {}) {
  await fs.copyFile(inputPath, outputPath);

  try {
    await cleanWithExifTool(outputPath, options);
    await validateCleanedVideo(inputPath, outputPath, options);
    return { outputPath, strategy: "exiftool-metadata" as const };
  } catch (error) {
    if (options.allowStreamCopyFallback === false) {
      throw error;
    }
  }

  await cleanWithStreamCopy(inputPath, outputPath, options);
  await validateCleanedVideo(inputPath, outputPath, options);
  return { outputPath, strategy: "ffmpeg-stream-copy" as const };
}
