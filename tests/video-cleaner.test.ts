import { describe, expect, it } from "vitest";
import {
  buildFfmpegStreamCopyArgs,
  buildFfprobeArgs,
  buildVideoExifToolArgs,
  validateVideoProbeSnapshots
} from "@/cleaners/video-cleaner";

describe("video cleaner", () => {
  it("builds safe ExifTool and ffprobe argument arrays", () => {
    expect(buildVideoExifToolArgs("/tmp/clip.mp4")).toEqual([
      "-all=",
      "-CreateDate=",
      "-ModifyDate=",
      "-TrackCreateDate=",
      "-TrackModifyDate=",
      "-MediaCreateDate=",
      "-MediaModifyDate=",
      "-overwrite_original",
      "/tmp/clip.mp4"
    ]);
    expect(buildFfprobeArgs("/tmp/clip.mp4")).toContain("/tmp/clip.mp4");
  });

  it("builds an FFmpeg stream-copy fallback without metadata or chapters", () => {
    expect(buildFfmpegStreamCopyArgs("/tmp/in.mp4", "/tmp/out.mp4")).toEqual([
      "-y",
      "-i",
      "/tmp/in.mp4",
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
      "-bitexact",
      "-movflags",
      "use_metadata_tags",
      "/tmp/out.mp4"
    ]);
  });

  it("does not add QuickTime movflags to non-ISO containers", () => {
    expect(buildFfmpegStreamCopyArgs("/tmp/in.mkv", "/tmp/out.mkv")).not.toContain("use_metadata_tags");
  });

  it("accepts dropped data tracks (e.g. SMPTE timecode) as metadata cleaning", () => {
    const original = {
      streams: [
        { codec_type: "video", codec_name: "h264", width: 3840, height: 2160 },
        { codec_type: "data" }
      ],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.0" }
    };
    const cleaned = {
      streams: [{ codec_type: "video", codec_name: "h264", width: 3840, height: 2160 }],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.0" }
    };

    expect(validateVideoProbeSnapshots(original, cleaned).valid).toBe(true);
  });

  it("accepts stream-copy validation when playback-relevant stream data is preserved", () => {
    const original = {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          avg_frame_rate: "30000/1001",
          pix_fmt: "yuv420p",
          color_range: "tv",
          color_space: "bt709",
          color_transfer: "bt709",
          color_primaries: "bt709",
          display_aspect_ratio: "16:9"
        },
        {
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "48000",
          channels: 2,
          channel_layout: "stereo"
        }
      ],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.010000" }
    };

    expect(validateVideoProbeSnapshots(original, structuredClone(original)).valid).toBe(true);
  });

  it("rejects video cleaning when codec, dimensions, or duration change", () => {
    const original = {
      streams: [{ codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, avg_frame_rate: "24/1" }],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "20.000000" }
    };

    expect(() =>
      validateVideoProbeSnapshots(original, {
        streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "24/1" }],
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "25.000000" }
      })
    ).toThrow("codec");
  });
});
