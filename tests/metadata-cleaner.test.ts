import { describe, expect, it } from "vitest";
import {
  buildCleanExifToolArgs,
  cleanTiffMetadata,
  findSensitiveMetadataKeys,
  validateMetadataSnapshots
} from "@/metadata-cleaner";

describe("metadata cleaner", () => {
  it("builds the ExifTool cleanup command in metadata-preserving order", () => {
    expect(buildCleanExifToolArgs("/tmp/clean.jpg")).toEqual([
      "-all=",
      "-tagsfromfile",
      "@",
      "-ColorSpaceTags",
      "-Orientation",
      "-YCbCrPositioning",
      "-overwrite_original",
      "/tmp/clean.jpg"
    ]);
  });

  it("accepts cleaned metadata with ICC and Orientation preserved", () => {
    const original = {
      "File:FileTypeExtension": "jpg",
      "File:ImageWidth": 20,
      "File:ImageHeight": 30,
      "ICC_Profile:ProfileDescription": "sRGB IEC61966-2.1",
      "IFD0:Orientation": "Rotate 90 CW",
      "XMP:Prompt": "private prompt"
    };
    const cleaned = {
      "File:FileTypeExtension": "jpg",
      "File:ImageWidth": 20,
      "File:ImageHeight": 30,
      "ICC_Profile:ProfileDescription": "sRGB IEC61966-2.1",
      "IFD0:Orientation": "Rotate 90 CW"
    };

    expect(validateMetadataSnapshots(original, cleaned).valid).toBe(true);
  });

  it("rejects missing ICC profiles when the original had one", () => {
    const original = {
      "File:FileTypeExtension": "png",
      "File:ImageWidth": 10,
      "File:ImageHeight": 10,
      "ICC_Profile:ProfileDescription": "Display P3"
    };
    const cleaned = {
      "File:FileTypeExtension": "png",
      "File:ImageWidth": 10,
      "File:ImageHeight": 10
    };

    expect(() => validateMetadataSnapshots(original, cleaned)).toThrow("ICC profile");
  });

  it("rejects changed dimensions", () => {
    expect(() =>
      validateMetadataSnapshots(
        {
          "File:FileTypeExtension": "webp",
          "File:ImageWidth": 10,
          "File:ImageHeight": 10
        },
        {
          "File:FileTypeExtension": "webp",
          "File:ImageWidth": 11,
          "File:ImageHeight": 10
        }
      )
    ).toThrow("width");
  });

  it("flags AI and private metadata after cleaning", () => {
    expect(
      findSensitiveMetadataKeys({
        "XMP:CreatorTool": "ComfyUI",
        "EXIF:Software": "Stable Diffusion",
        "PNG:Parameters": "prompt",
        "ICC_Profile:ProfileDescription": "sRGB"
      })
    ).toEqual(["XMP:CreatorTool", "EXIF:Software", "PNG:Parameters"]);
  });

  it("ignores exiftool -G1 filesystem tags in the System group", () => {
    expect(
      findSensitiveMetadataKeys({
        "System:FileName": "cleaned.jpg",
        "System:FileModifyDate": "2026:07:03 20:00:00+02:00",
        "System:FileAccessDate": "2026:07:03 20:00:00+02:00",
        "System:FileInodeChangeDate": "2026:07:03 20:00:00+02:00",
        "System:FilePermissions": "-rw-r--r--"
      })
    ).toEqual([]);
  });

  it("allows structural container tags but flags real container metadata", () => {
    expect(
      findSensitiveMetadataKeys({
        "QuickTime:MajorBrand": "MP4 Base Media v1",
        "QuickTime:TimeScale": 1000,
        "Track1:AudioSampleRate": 44100,
        "Track1:HandlerDescription": "SoundHandler",
        "PDF:PDFVersion": 1.7,
        "PDF:Linearized": "No",
        "PDF:PageCount": 3,
        "MPEG:CopyrightFlag": "False",
        "RIFF:SampleRate": 44100,
        "FLAC:MD5Signature": "abc",
        "QuickTime:Title": "Secret",
        "PDF:Author": "Secret Author",
        "ItemList:Comment": "private"
      })
    ).toEqual(["QuickTime:Title", "PDF:Author", "ItemList:Comment"]);
  });

  it("treats zeroed MP4 header dates as cleaned but flags real dates", () => {
    expect(
      findSensitiveMetadataKeys({
        "QuickTime:CreateDate": "0000:00:00 00:00:00",
        "Track1:MediaModifyDate": "0000:00:00 00:00:00",
        "QuickTime:ModifyDate": "2026:07:03 18:18:06"
      })
    ).toEqual(["QuickTime:ModifyDate"]);
  });

  it("allows our own FFmpeg muxer signature but flags foreign tool signatures", () => {
    expect(
      findSensitiveMetadataKeys({
        "Info:MuxingApp": "Lavf",
        "Info:WritingApp": "Lavf",
        "Vorbis:Vendor": "ffmpeg"
      })
    ).toEqual([]);

    expect(
      findSensitiveMetadataKeys({
        "Info:WritingApp": "HandBrake 1.7.2",
        "Track1:HandlerDescription": "Recorded on John's iPhone"
      })
    ).toEqual(["Info:WritingApp", "Track1:HandlerDescription"]);
  });

  it("does not let a crafted AAC:Encoder smuggle private data past the muxer whitelist", () => {
    // AAC:Encoder is read from attacker-controlled ADTS filler that survives a
    // stream-copy, so only our exact signature+version may be whitelisted; any
    // trailing free text must keep the key flagged as sensitive.
    expect(findSensitiveMetadataKeys({ "AAC:Encoder": "Lavc62.28.102" })).toEqual([]);
    expect(findSensitiveMetadataKeys({ "AAC:Encoder": "Lavf GPS48.8583,2.2945 author=JaneDoe" })).toEqual([
      "AAC:Encoder"
    ]);
    expect(findSensitiveMetadataKeys({ "AAC:Encoder": "Lavc60.31.102 extra secret" })).toEqual(["AAC:Encoder"]);
    // Existing container signatures our remux fully rewrites must still pass.
    expect(
      findSensitiveMetadataKeys({ "Info:MuxingApp": "Lavf", "Info:WritingApp": "Lavf62.3.100", "Vorbis:Vendor": "ffmpeg" })
    ).toEqual([]);
  });

  it("allows PDF viewer-preference keys that ExifTool cannot strip", () => {
    expect(
      findSensitiveMetadataKeys({
        "PDF:PageLayout": "SinglePage",
        "PDF:PageMode": "UseOutlines",
        "PDF:PageCount": 24,
        "PDF:Author": "Leaked Author"
      })
    ).toEqual(["PDF:Author"]);
  });

  it("allows our own FFmpeg AAC encoder stamp but flags a foreign encoder", () => {
    expect(findSensitiveMetadataKeys({ "AAC:Encoder": "Lavc62.28.102" })).toEqual([]);
    expect(findSensitiveMetadataKeys({ "AAC:Encoder": "Nero AAC 1.5.4" })).toEqual(["AAC:Encoder"]);
  });

  it("allows AAC stream descriptors (SampleRate must not match the 'Sampler' token)", () => {
    expect(
      findSensitiveMetadataKeys({
        "AAC:ProfileType": "Low Complexity",
        "AAC:SampleRate": 44100,
        "AAC:Channels": 2
      })
    ).toEqual([]);
  });

  it("preserves an image whose only colour tag is YCbCrPositioning", () => {
    // Reproduces the HEIC/AVIF/WebP color-guard case: -YCbCrPositioning is copied
    // back so cleaned still has a colour value and the guard passes.
    const original = {
      "File:FileTypeExtension": "heic",
      "File:ImageWidth": 100,
      "File:ImageHeight": 100,
      "IFD0:YCbCrPositioning": "Centered",
      "XMP:Description": "private"
    };
    const cleaned = {
      "File:FileTypeExtension": "heic",
      "File:ImageWidth": 100,
      "File:ImageHeight": 100,
      "IFD0:YCbCrPositioning": "Centered"
    };
    expect(validateMetadataSnapshots(original, cleaned).valid).toBe(true);
  });
});

describe("TIFF cleaner", () => {
  it("strips via ImageMagick then restores only colour tags from the original", async () => {
    const calls: Array<{ tool: string; args: string[] }> = [];
    const imageMagickRunner = async (args: string[]) => {
      calls.push({ tool: "magick", args });
      return { stdout: "", stderr: "" };
    };
    const exifToolRunner = async (args: string[]) => {
      calls.push({ tool: "exiftool", args });
      return { stdout: "", stderr: "" };
    };

    await cleanTiffMetadata("/tmp/in.tiff", "/tmp/out.tiff", { imageMagickRunner, exifToolRunner });

    expect(calls[0]).toEqual({ tool: "magick", args: ["/tmp/in.tiff", "-strip", "/tmp/out.tiff"] });
    expect(calls[1].tool).toBe("exiftool");
    // Colour restore must read from the ORIGINAL, never re-add sensitive tags.
    expect(calls[1].args).toEqual([
      "-tagsfromfile",
      "/tmp/in.tiff",
      "-ICC_Profile",
      "-ColorSpaceTags",
      "-Orientation",
      "-overwrite_original",
      "/tmp/out.tiff"
    ]);
  });
});
