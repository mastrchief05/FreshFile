import fs from "node:fs/promises";
import type { ExifToolRunner } from "../runtime/exiftool-runner";
import { defaultExifToolRunner, ExifToolError } from "../runtime/exiftool-runner";
import { defaultImageMagickRunner, type ToolRunner } from "../runtime/media-tool-runner";

export type MetadataMap = Record<string, unknown>;

export type CleanImageMetadataOptions = {
  runner?: ExifToolRunner;
  timeoutMs?: number;
};

export type ValidationResult = {
  valid: true;
  original: MetadataMap;
  cleaned: MetadataMap;
};

export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataValidationError";
  }
}

export function buildCleanExifToolArgs(filePath: string) {
  return [
    "-all=",
    "-tagsfromfile",
    "@",
    "-ColorSpaceTags",
    "-Orientation",
    // YCbCrPositioning is chroma-sampling geometry, not identity. It is the only
    // colour-signalling tag some HEIC/AVIF/WebP carry, so losing it would trip
    // the colour-preservation guard and wrongly reject an otherwise-clean image.
    "-YCbCrPositioning",
    "-overwrite_original",
    filePath
  ];
}

export async function cleanImageMetadata(
  inputPath: string,
  outputPath: string,
  options: CleanImageMetadataOptions = {}
) {
  await fs.copyFile(inputPath, outputPath);
  const runner = options.runner ?? defaultExifToolRunner;
  await runner(buildCleanExifToolArgs(outputPath), { timeoutMs: options.timeoutMs ?? 15_000 });
  return outputPath;
}

export type TiffCleanerOptions = {
  exifToolRunner?: ExifToolRunner;
  imageMagickRunner?: ToolRunner;
  timeoutMs?: number;
};

export function buildImageMagickStripArgs(inputPath: string, outputPath: string) {
  // Rewrite the raster and drop every metadata profile/tag ImageMagick knows,
  // including the IFD0 tags (Artist/Software/Copyright/ImageDescription) that
  // ExifTool cannot delete from a TIFF. Pixels are preserved bit-for-bit.
  //
  // The -limit flags MUST precede the input: ImageMagick applies them as it
  // reads arguments, so they only bound the decode if set first. A 138-byte
  // TIFF declaring 50000x50000 pixels otherwise forces a ~10 GB allocation
  // (pixel bomb) before libtiff errors — a single-upload OOM of the worker.
  return [
    "-limit", "area", "128MP",
    "-limit", "width", "50000",
    "-limit", "height", "50000",
    "-limit", "memory", "512MiB",
    "-limit", "map", "512MiB",
    "-limit", "disk", "1GiB",
    "-limit", "thread", "1",
    inputPath,
    "-strip",
    outputPath
  ];
}

export function buildTiffColorRestoreArgs(originalPath: string, outputPath: string) {
  // -strip also removes the ICC profile and colour/orientation signalling, so
  // copy exactly those back from the untouched original to keep fidelity. These
  // are colour-reproduction tags only; any leftover privacy tag would still be
  // caught by validateCleanedImage.
  return [
    "-tagsfromfile",
    originalPath,
    "-ICC_Profile",
    "-ColorSpaceTags",
    "-Orientation",
    "-overwrite_original",
    outputPath
  ];
}

// TIFF cleaner: ExifTool cannot strip TIFF IFD0 tags, so ImageMagick rewrites the
// file without metadata and ExifTool then restores only the colour profile.
export async function cleanTiffMetadata(
  inputPath: string,
  outputPath: string,
  options: TiffCleanerOptions = {}
) {
  const magick = options.imageMagickRunner ?? defaultImageMagickRunner;
  const exif = options.exifToolRunner ?? defaultExifToolRunner;
  await magick(buildImageMagickStripArgs(inputPath, outputPath), { timeoutMs: options.timeoutMs ?? 60_000 });
  await exif(buildTiffColorRestoreArgs(inputPath, outputPath), { timeoutMs: options.timeoutMs ?? 15_000 });
  return outputPath;
}

export async function inspectImageMetadata(
  filePath: string,
  options: CleanImageMetadataOptions = {}
): Promise<MetadataMap> {
  const runner = options.runner ?? defaultExifToolRunner;
  const { stdout } = await runner(["-j", "-a", "-G1", "-s", filePath], {
    timeoutMs: options.timeoutMs ?? 10_000
  });

  const parsed = JSON.parse(stdout) as MetadataMap[];
  return parsed[0] ?? {};
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function dimension(meta: MetadataMap, key: string) {
  const direct = meta[`File:${key}`] ?? meta[`Composite:${key}`] ?? meta[key];
  if (typeof direct === "number") return direct;
  if (typeof direct === "string") return Number.parseInt(direct, 10);
  return undefined;
}

function normalizeFileType(meta: MetadataMap) {
  const value = stringValue(meta["File:FileTypeExtension"] ?? meta["File:FileType"] ?? meta.FileTypeExtension ?? meta.FileType);
  return value?.toLowerCase().replace("jpeg", "jpg");
}

function orientation(meta: MetadataMap) {
  return stringValue(meta["IFD0:Orientation"] ?? meta["EXIF:Orientation"] ?? meta.Orientation);
}

function hasIccProfile(meta: MetadataMap) {
  return Object.keys(meta).some((key) => key.startsWith("ICC_Profile:") || key === "ICC_Profile");
}

function colorSpaceValues(meta: MetadataMap) {
  return Object.entries(meta).filter(([key]) => /(^|:)Color|ICC|WhitePoint|Chromaticities|Gamma|TransferFunction|YCbCr/i.test(key));
}

function compareIfPresent(original: MetadataMap, cleaned: MetadataMap, key: string) {
  const originalValue = stringValue(original[`File:${key}`] ?? original[key]);
  const cleanedValue = stringValue(cleaned[`File:${key}`] ?? cleaned[key]);
  if (originalValue !== undefined && cleanedValue !== undefined && originalValue !== cleanedValue) {
    throw new MetadataValidationError(`${key} changed during cleaning.`);
  }
}

// Filesystem and derived pseudo-groups reported by `exiftool -G1`. These describe
// the file on disk (or values computed from other tags), not embedded metadata.
const skippedGroupsPattern = /^(System|ExifTool|Composite):/;

const allowedExact = new Set([
  "SourceFile",
  "ExifTool:ExifToolVersion",
  // The minimal 14-byte JFIF APP0 the browser cleaner keeps: version and DPI
  // are rendering data (like ICC), with thumbnail counts zeroed. Everything
  // else in the JFIF group (thumbnails, extensions) stays sensitive.
  "JFIF:JFIFVersion",
  "JFIF:ResolutionUnit",
  "JFIF:XResolution",
  "JFIF:YResolution",
  "File:FileName",
  "File:Directory",
  "File:FileSize",
  "File:FileModifyDate",
  "File:FileAccessDate",
  "File:FileInodeChangeDate",
  "File:FilePermissions",
  "File:FileType",
  "File:FileTypeExtension",
  "File:MIMEType",
  "File:ImageWidth",
  "File:ImageHeight",
  "File:ImageSize",
  "File:Megapixels",
  "File:BitsPerSample",
  "File:ColorComponents",
  "File:YCbCrSubSampling",
  "File:EncodingProcess",
  "File:ExifByteOrder",
  "File:ID3Size",
  "Composite:ImageSize",
  "Composite:Megapixels",
  "IFD0:Orientation",
  "EXIF:Orientation"
]);

const allowedColorPattern = /^(ICC_Profile|ExifIFD|IFD0|EXIF|PNG|File):.*(Color|ICC|WhitePoint|Chromaticities|Gamma|TransferFunction|YCbCr|Primary|Profile|RenderingIntent)/i;

// Structural container fields that describe playback/rendering, not user or tool
// provenance. Grounded against real `exiftool -G1` output for cleaned files.
const structuralPatterns: RegExp[] = [
  /^(QuickTime|Track\d+):(MajorBrand|MinorVersion|CompatibleBrands|MovieHeaderVersion|TimeScale|Duration|PreferredRate|PreferredVolume|PreviewTime|PreviewDuration|PosterTime|SelectionTime|SelectionDuration|CurrentTime|NextTrackID|MediaDataSize|MediaDataOffset|TrackHeaderVersion|TrackID|TrackLayer|TrackVolume|TrackDuration|MatrixStructure|MediaHeaderVersion|MediaTimeScale|MediaDuration|MediaLanguageCode|HandlerType|HandlerVendorID|GraphicsMode|OpColor|CompressorID|CompressorName|SourceImageWidth|SourceImageHeight|XResolution|YResolution|BitDepth|PixelAspectRatio|BufferSize|MaxBitrate|AverageBitrate|VideoFrameRate|VideoScanType|Balance|AudioFormat|AudioChannels|AudioBitsPerSample|AudioSampleRate|ImageWidth|ImageHeight|Rotation)$/,
  // HEIF/AVIF still images (HEIC, AVIF) report codec configuration and color
  // signaling under the QuickTime group; none of it identifies user or tool.
  /^QuickTime:(ColorProfiles|ColorPrimaries|TransferCharacteristics|MatrixCoefficients|VideoFullRangeFlag|ImageSpatialExtent|CleanAperture|ImagePixelDepth|HEVCConfigurationVersion|GeneralProfileSpace|GeneralTierFlag|GeneralProfileIDC|GenProfileCompatibilityFlags|ConstraintIndicatorFlags|GeneralLevelIDC|MinSpatialSegmentationIDC|ParallelismType|ChromaFormat|ChromaSamplePosition|BitDepthLuma|BitDepthChroma|AverageFrameRate|ConstantFrameRate|NumTemporalLayers|TemporalIDNested|AV1ConfigurationVersion|SeqProfile|SeqLevelIdx0|SeqTier0|HighBitdepth|TwelveBit|Monochrome|ChromaSubsamplingX|ChromaSubsamplingY|MaxContentLightLevel|MaxPicAverageLightLevel|MaxCLL|MaxFALL|MasteringDisplay\w*|MaxLuminance|MinLuminance|WhitePoint\w*|ColorRepresentation)$/,
  /^(Matroska|Info|Track\d+):(EBMLVersion|EBMLReadVersion|DocType|DocTypeVersion|DocTypeReadVersion|TimecodeScale|Duration|TrackNumber|TrackUID|TrackLanguage|TrackType|TagTrackUID|CodecID|CodecDelay|SeekPreRoll|DefaultDuration|FlagLacing|FlagDefault|FlagForced|MinCache|MaxCache|VideoFrameRate|VideoScanType|ImageWidth|ImageHeight|DisplayWidth|DisplayHeight|DisplayUnit|AudioChannels|AudioSampleRate|AudioBitsPerSample)$/,
  /^RIFF:(Encoding|NumChannels|SampleRate|AvgBytesPerSec|BitsPerSample|SampleSize|FrameRate|FrameCount|MaxDataRate|StreamCount|ImageWidth|ImageHeight|ImageLength|Planes|BitDepth|Compression|VideoCodec|VideoFrameRate|VideoFrameCount|AudioCodec|AudioSampleRate|AudioSampleCount|Quality|StreamType|TotalFrameCount|WebP_Flags|VP8Version|VP8LVersion|HorizontalScale|VerticalScale|AlphaPreprocessing|AlphaFiltering|AlphaCompression|AnimationLoopCount|BackgroundColor|Duration|Transparency)$/,
  /^FLAC:(BlockSizeMin|BlockSizeMax|FrameSizeMin|FrameSizeMax|SampleRate|Channels|BitsPerSample|TotalSamples|MD5Signature)$/,
  /^MPEG:(MPEGAudioVersion|AudioLayer|AudioBitrate|SampleRate|ChannelMode|MSStereo|IntensityStereo|CopyrightFlag|OriginalMedia|Emphasis|VBRFrames|VBRBytes|VBRScale)$/,
  /^(Vorbis|Opus|Ogg|Theora):(VorbisVersion|OpusVersion|AudioChannels|SampleRate|OriginalSampleRate|NominalBitrate|MaximumBitrate|MinimumBitrate|OutputGain|ChannelMappingFamily|BlockSize0|BlockSize1|PageCount|StreamCount)$/,
  // PageLayout/PageMode are viewer-display preferences (e.g. SinglePage,
  // UseOutlines) stored in the PDF catalog, not user or tool provenance.
  // ExifTool cannot strip them, and they carry no identity, so they are allowed.
  /^PDF:(PDFVersion|Linearized|PageCount|PageLayout|PageMode|TaggedPDF|Encryption|Language|HasXFA)$/,
  /^AIFF:(FormType|NumChannels|NumSampleFrames|SampleSize|SampleRate|CompressionType|CompressorName)$/,
  // Bare ADTS AAC stream descriptors. SampleRate in particular must be listed
  // explicitly: the substring "SampleR" otherwise matches the AI token "Sampler".
  /^AAC:(ProfileType|SampleRate|Channels|ChannelConfiguration)$/,
  /^ZIP:(ZipRequiredVersion|ZipBitFlag|ZipCompression|ZipUncompressedSize|ZipCompressedSize|ZipCRC|ZipFileName|ZipFileCount|ZipObjectCount)$/,
  // EPUB keeps spec-required fields: identifier (rewritten to a derived urn),
  // title and language are reader-visible content. Manifest/spine tags are
  // structural package plumbing.
  /^XML-dc:(Title|Identifier|IdentifierId|Language)$/,
  /^XML:(ManifestItemId|ManifestItemHref|ManifestItemMedia-type|ManifestItemProperties|SpineItemrefIdref|SpineToc|MetaProperty|PackageVersion|PackageUniqueIdentifier)$/
];

// MP4/MOV header timestamps cannot be deleted, only zeroed, and ZIP entry
// timestamps can only be reset to the DOS epoch (1980-01-01). Neither carries
// information after that, so both count as cleaned.
const zeroableDatePattern =
  /^((QuickTime|Track\d+):(CreateDate|ModifyDate|TrackCreateDate|TrackModifyDate|MediaCreateDate|MediaModifyDate)|ZIP:ZipModifyDate|XML:Meta)$/;

// Muxer/encoder signatures written by our own FFmpeg step. They identify the
// cleaning tool (Lavf/Lavc/ffmpeg), not the uploader's toolchain. AAC:Encoder is
// read from the ADTS bitstream filler, which -c:a copy preserves verbatim and is
// attacker-controlled printable text, so the value must be ONLY our signature
// plus a version — no trailing free text (which could smuggle GPS/author data).
const muxerVendorKeyPattern = /^(Info:(MuxingApp|WritingApp)|(Vorbis|Ogg|Opus):Vendor|AAC:Encoder)$/;
const muxerVendorValuePattern = /^(Lavf|Lavc|ffmpeg)[\d.]*$/i;

const handlerDescriptionKeyPattern = /^(QuickTime|Track\d+):HandlerDescription$/;
const handlerDescriptionValuePattern =
  /^(VideoHandler|SoundHandler|DataHandler|SubtitleHandler|PictureHandler|Core Media (Video|Audio|Data Handler)|Apple (Video|Sound) Media Handler|Apple Alias Data Handler|GPAC ISO (Video|Audio) Handler|L-SMASH (Video|Audio) Handler)$/;

const sensitivePattern =
  /(^XMP|^IPTC|^GPS|^Maker|^Photoshop|^JFIF|^ID3|^QuickTime|^Matroska|^Info:|^RIFF|^PDF|^Keys|^ItemList|^UserData|^XML|^ZIP|^OOXML|^EPUB|^RTF|^FlashPix|:GPS|:XMP|:IPTC|Prompt|Workflow|Parameters|NegativePrompt|Seed|Sampler|Scheduler|Model|Generator|Encoder|Encoded|Software|Application|AppVersion|Creator|Author|Artist|Producer|Company|Manager|Copyright|Comment|Description|Title|Subject|Keywords|CreateDate|ModifyDate|CreationDate|ModificationDate|UserComment|Instructions|Credit|Source|History|DocumentID|InstanceID|LastModifiedBy|RevisionNumber|TotalEditTime|Template|Comfy|Automatic1111|StableDiffusion|Midjourney|DALL|Firefly|Leonardo|Ideogram|Gemini)/i;

function isZeroDate(value: unknown) {
  return (
    typeof value === "string" &&
    (/^0000[:-]00[:-]00[ T]00:00:00/.test(value) || /^1980[:-]01[:-]01[ T]00:00(:00)?/.test(value))
  );
}

export function findSensitiveMetadataKeys(meta: MetadataMap) {
  return Object.entries(meta)
    .filter(([key, value]) => {
      if (skippedGroupsPattern.test(key)) return false;
      if (allowedExact.has(key)) return false;
      // All ICC groups (ICC_Profile, ICC-header, ICC-view, ICC-meas) are color
      // reproduction data that FreshFile explicitly preserves.
      if (/^ICC[-_]/i.test(key)) return false;
      if (allowedColorPattern.test(key)) return false;
      if (structuralPatterns.some((pattern) => pattern.test(key))) return false;
      if (zeroableDatePattern.test(key) && isZeroDate(value)) return false;
      if (muxerVendorKeyPattern.test(key) && typeof value === "string" && muxerVendorValuePattern.test(value)) {
        return false;
      }
      if (
        handlerDescriptionKeyPattern.test(key) &&
        typeof value === "string" &&
        handlerDescriptionValuePattern.test(value)
      ) {
        return false;
      }
      return sensitivePattern.test(key);
    })
    .map(([key]) => key);
}

export function validateMetadataSnapshots(original: MetadataMap, cleaned: MetadataMap) {
  const originalType = normalizeFileType(original);
  const cleanedType = normalizeFileType(cleaned);
  if (originalType && cleanedType && originalType !== cleanedType) {
    throw new MetadataValidationError("File format changed during cleaning.");
  }

  const originalWidth = dimension(original, "ImageWidth");
  const originalHeight = dimension(original, "ImageHeight");
  const cleanedWidth = dimension(cleaned, "ImageWidth");
  const cleanedHeight = dimension(cleaned, "ImageHeight");

  if (originalWidth && cleanedWidth && originalWidth !== cleanedWidth) {
    throw new MetadataValidationError("Image width changed during cleaning.");
  }

  if (originalHeight && cleanedHeight && originalHeight !== cleanedHeight) {
    throw new MetadataValidationError("Image height changed during cleaning.");
  }

  if (hasIccProfile(original) && !hasIccProfile(cleaned)) {
    throw new MetadataValidationError("ICC profile was not preserved.");
  }

  const originalOrientation = orientation(original);
  const cleanedOrientation = orientation(cleaned);
  if (originalOrientation && originalOrientation !== cleanedOrientation) {
    throw new MetadataValidationError("Orientation tag was not preserved.");
  }

  if (colorSpaceValues(original).length > 0 && colorSpaceValues(cleaned).length === 0) {
    throw new MetadataValidationError("Color-space metadata was not preserved.");
  }

  compareIfPresent(original, cleaned, "BitDepth");
  compareIfPresent(original, cleaned, "BitsPerSample");
  compareIfPresent(original, cleaned, "ColorType");
  compareIfPresent(original, cleaned, "ColorComponents");
  compareIfPresent(original, cleaned, "FrameCount");
  compareIfPresent(original, cleaned, "PageCount");

  const remainingSensitiveKeys = findSensitiveMetadataKeys(cleaned);
  if (remainingSensitiveKeys.length > 0) {
    throw new MetadataValidationError("Privacy metadata remained after cleaning.");
  }

  return { valid: true as const, original, cleaned };
}

export async function validateCleanedImage(
  originalPath: string,
  cleanedPath: string,
  options: CleanImageMetadataOptions = {}
): Promise<ValidationResult> {
  try {
    const [original, cleaned] = await Promise.all([
      inspectImageMetadata(originalPath, options),
      inspectImageMetadata(cleanedPath, options)
    ]);
    return validateMetadataSnapshots(original, cleaned);
  } catch (error) {
    if (error instanceof MetadataValidationError || error instanceof ExifToolError) {
      throw error;
    }
    throw new MetadataValidationError("Could not validate cleaned image.");
  }
}
