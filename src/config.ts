// Engine configuration. The cleaning engine must run outside the website
// (CLI, library consumers), so it cannot depend on the web app's env schema.
// Every setting resolves lazily at use time with the precedence
// configureFreshfile() > environment variable > built-in default, so merely
// importing the engine never throws and the website's existing Docker env
// vars (EXIFTOOL_PATH etc.) keep working without extra wiring.

import type { FileCategory } from "./job-types";

export type ConfigurableTool = "exiftool" | "ffmpeg" | "ffprobe" | "imagemagick" | "qpdf";

export type MaxUploadBytes = number | ((category: FileCategory) => number);

export type FreshfileConfig = {
  exiftoolPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  imagemagickPath?: string;
  qpdfPath?: string;
  // Upload size ceiling. Absent means unlimited: local files never leave the
  // machine, so only hosted deployments need to cap request sizes.
  maxUploadBytes?: MaxUploadBytes;
  tempFileTtlMinutes?: number;
};

const config: FreshfileConfig = {};

export function configureFreshfile(overrides: FreshfileConfig) {
  Object.assign(config, overrides);
}

const TOOLS: Record<
  ConfigurableTool,
  { configKey: keyof FreshfileConfig; envVar: string; fallback: string }
> = {
  exiftool: { configKey: "exiftoolPath", envVar: "EXIFTOOL_PATH", fallback: "exiftool" },
  ffmpeg: { configKey: "ffmpegPath", envVar: "FFMPEG_PATH", fallback: "ffmpeg" },
  ffprobe: { configKey: "ffprobePath", envVar: "FFPROBE_PATH", fallback: "ffprobe" },
  // ImageMagick command. Debian's `imagemagick` package (v6) ships `convert`;
  // ImageMagick 7 also keeps `convert` as a compatibility alias.
  imagemagick: { configKey: "imagemagickPath", envVar: "IMAGEMAGICK_PATH", fallback: "convert" },
  qpdf: { configKey: "qpdfPath", envVar: "QPDF_PATH", fallback: "qpdf" }
};

export function getToolPath(tool: ConfigurableTool) {
  const { configKey, envVar, fallback } = TOOLS[tool];
  const configured = config[configKey];
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }

  const fromEnv = process.env[envVar]?.trim();
  return fromEnv || fallback;
}

export function resolveMaxUploadBytes(category: FileCategory, override?: MaxUploadBytes) {
  const resolver = override ?? config.maxUploadBytes;
  if (resolver === undefined) return null;
  return typeof resolver === "function" ? resolver(category) : resolver;
}

export function getTempFileTtlMinutes(override?: number) {
  if (override !== undefined) return override;
  if (config.tempFileTtlMinutes !== undefined) return config.tempFileTtlMinutes;

  const fromEnv = Number(process.env.TEMP_FILE_TTL_MINUTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 60;
}
