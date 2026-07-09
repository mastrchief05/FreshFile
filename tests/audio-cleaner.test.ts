import { describe, expect, it } from "vitest";
import { buildAudioExifToolArgs, buildFfmpegAudioCopyArgs, validateCleanedAudio } from "@/cleaners/audio-cleaner";
import type { ToolRunner } from "@/runtime/media-tool-runner";
import type { ExifToolRunner } from "@/runtime/exiftool-runner";

describe("audio cleaner", () => {
  it("builds the audio metadata removal command without shell interpolation", () => {
    expect(buildAudioExifToolArgs("/tmp/song.m4a")).toEqual([
      "-all=",
      "-CreateDate=",
      "-ModifyDate=",
      "-TrackCreateDate=",
      "-TrackModifyDate=",
      "-MediaCreateDate=",
      "-MediaModifyDate=",
      "-overwrite_original",
      "/tmp/song.m4a"
    ]);
  });

  it("builds an FFmpeg stream-copy fallback that drops metadata and encoder signatures", () => {
    expect(buildFfmpegAudioCopyArgs("/tmp/in.mp3", "/tmp/out.mp3")).toEqual([
      "-y",
      "-i",
      "/tmp/in.mp3",
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
      "/tmp/out.mp3"
    ]);
  });

  it("validates cleaned audio when sensitive tags are gone", async () => {
    const runner: ExifToolRunner = async (args) => {
      const filePath = args.at(-1);
      return {
        stdout: JSON.stringify([
          filePath === "cleaned.mp3"
            ? { "File:FileTypeExtension": "mp3" }
            : { "File:FileTypeExtension": "mp3", "ID3:Title": "Private title" }
        ]),
        stderr: ""
      };
    };
    const ffprobeRunner: ToolRunner = async () => ({
      stdout: JSON.stringify({
        streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 }]
      }),
      stderr: ""
    });

    await expect(validateCleanedAudio("original.mp3", "cleaned.mp3", { runner, ffprobeRunner })).resolves.toMatchObject({
      valid: true
    });
  });

  it("accepts ID3-stripped AAC whose container label flips from mp3 to aac", async () => {
    // An ID3v2 header makes ExifTool report bare AAC as "mp3"; removing it flips
    // the label to "aac". The codec is unchanged, so this is a valid clean.
    const runner: ExifToolRunner = async (args) => {
      const filePath = args.at(-1);
      return {
        stdout: JSON.stringify([
          filePath === "cleaned.aac"
            ? { "File:FileTypeExtension": "aac", "AAC:SampleRate": 44100, "AAC:Encoder": "Lavc62.28.102" }
            : { "File:FileTypeExtension": "mp3", "File:ID3Size": 167, "ID3v2_4:Artist": "Mia Musterfrau" }
        ]),
        stderr: ""
      };
    };
    const ffprobeRunner: ToolRunner = async () => ({
      stdout: JSON.stringify({
        streams: [{ codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 }]
      }),
      stderr: ""
    });

    await expect(validateCleanedAudio("original.aac", "cleaned.aac", { runner, ffprobeRunner })).resolves.toMatchObject({
      valid: true
    });
  });

  it("still rejects a genuine format change when the original had no ID3 wrapper", async () => {
    const runner: ExifToolRunner = async (args) => ({
      stdout: JSON.stringify([
        { "File:FileTypeExtension": args.at(-1) === "cleaned.wav" ? "mp3" : "wav" }
      ]),
      stderr: ""
    });
    const ffprobeRunner: ToolRunner = async () => ({
      stdout: JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "pcm_s16le" }] }),
      stderr: ""
    });

    await expect(validateCleanedAudio("original.wav", "cleaned.wav", { runner, ffprobeRunner })).rejects.toThrow(
      "Audio format changed"
    );
  });

  it("rejects cleaned audio that still contains non-audio streams", async () => {
    const runner: ExifToolRunner = async () => ({ stdout: JSON.stringify([{ "File:FileTypeExtension": "mp3" }]), stderr: "" });
    const ffprobeRunner: ToolRunner = async (args) => ({
      stdout: JSON.stringify({
        streams: args.at(-1) === "cleaned.mp3"
          ? [
              { codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 },
              { codec_type: "video", codec_name: "png" }
            ]
          : [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 }]
      }),
      stderr: ""
    });

    await expect(validateCleanedAudio("original.mp3", "cleaned.mp3", { runner, ffprobeRunner })).rejects.toThrow(
      "Non-audio streams"
    );
  });
});
