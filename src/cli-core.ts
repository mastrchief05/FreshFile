import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cleanFile, CleaningFailedError } from "./clean-file";
import { getToolPath, type ConfigurableTool } from "./config";
import { validateUploadedFile, UploadValidationError } from "./file-validation";
import { inspectImageMetadata, findSensitiveMetadataKeys } from "./metadata-cleaner";
import { categorizeServerKeys, categoryLabels, type MetadataCategory } from "./metadata-categories";
import { PLAIN_TEXT_FORMATS } from "./document-cleaner";
import { createStorageName, deleteTempFiles, getTempPath, writeTempFile } from "./temp-files";

export const EXIT_OK = 0;
export const EXIT_FILE_FAILED = 1;
export const EXIT_USAGE = 2;

export const DEFAULT_PREFIX = "fresh_";

const USAGE = `freshfile — remove metadata from images, videos, audio, PDFs and documents.

Usage:
  freshfile clean <files...>    Write a cleaned copy next to each file (fresh_<name>)
  freshfile inspect <files...>  Show which metadata a clean would remove (dry run)
  freshfile doctor              Check that the required external tools are installed
  freshfile finder-install      Install the macOS Finder Quick Action

Options:
  -o, --out-dir <dir>  Write cleaned files into <dir> instead of next to the source
      --prefix <p>     Output filename prefix (default: "${DEFAULT_PREFIX}")
      --json           Machine-readable output
  -h, --help           Show this help

The original file is never modified. An existing cleaned copy from a
previous run is overwritten.`;

export type FileReport = {
  file: string;
  ok: boolean;
  output?: string;
  strategy?: string;
  removedCategories?: MetadataCategory[];
  removedFieldCount?: number;
  error?: string;
};

type CliIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: CliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line)
};

function describeError(error: unknown) {
  if (error instanceof UploadValidationError || error instanceof CleaningFailedError) return error.message;
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return "File not found.";
  return error instanceof Error ? error.message : "Unknown error.";
}

function summarizeRemoved(report: FileReport) {
  if (!report.removedFieldCount) return "no sensitive fields";
  const labels = categoryLabels(report.removedCategories ?? []).join(", ");
  return `${report.removedFieldCount} field${report.removedFieldCount === 1 ? "" : "s"} (${labels})`;
}

async function validateLocalFile(filePath: string) {
  const buffer = await fs.readFile(filePath);
  // No maxUploadBytes: local files never leave the machine, so the hosted
  // upload caps do not apply here.
  const upload = await validateUploadedFile(buffer, path.basename(filePath));
  return { buffer, upload };
}

export function outputPathFor(filePath: string, prefix: string, outDir?: string) {
  const directory = outDir ?? path.dirname(filePath);
  return path.join(directory, `${prefix}${path.basename(filePath)}`);
}

export async function cleanOne(filePath: string, prefix: string, outDir?: string): Promise<FileReport> {
  let originalStorageName: string | undefined;
  let cleanedStorageName: string | undefined;

  try {
    const { buffer, upload } = await validateLocalFile(filePath);
    originalStorageName = createStorageName(upload.extension);
    cleanedStorageName = createStorageName(upload.outputExtension);
    await writeTempFile(originalStorageName, buffer);

    const result = await cleanFile(upload, getTempPath(originalStorageName), getTempPath(cleanedStorageName));
    const output = outputPathFor(filePath, prefix, outDir);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(getTempPath(cleanedStorageName), output);

    return {
      file: filePath,
      ok: true,
      output,
      strategy: result.strategy,
      removedCategories: result.removedCategories,
      removedFieldCount: result.removedFieldCount
    };
  } catch (error) {
    return { file: filePath, ok: false, error: describeError(error) };
  } finally {
    await deleteTempFiles([originalStorageName, cleanedStorageName]).catch(() => undefined);
  }
}

export async function inspectOne(filePath: string): Promise<FileReport> {
  let storageName: string | undefined;

  try {
    const { buffer, upload } = await validateLocalFile(filePath);

    if (upload.category === "svg") {
      return { file: filePath, ok: true, removedCategories: ["svg"], removedFieldCount: 0 };
    }
    if (PLAIN_TEXT_FORMATS.has(upload.format)) {
      return { file: filePath, ok: true, removedCategories: [], removedFieldCount: 0 };
    }

    // ExifTool reads the copy in the temp workspace, mirroring how the engine
    // inspects uploads (never the user's original path).
    storageName = createStorageName(upload.extension);
    await writeTempFile(storageName, buffer);
    const meta = await inspectImageMetadata(getTempPath(storageName));
    const keys = findSensitiveMetadataKeys(meta);

    return {
      file: filePath,
      ok: true,
      removedCategories: categorizeServerKeys(keys),
      removedFieldCount: keys.length
    };
  } catch (error) {
    return { file: filePath, ok: false, error: describeError(error) };
  } finally {
    await deleteTempFiles([storageName]).catch(() => undefined);
  }
}

const DOCTOR_TOOLS: Array<{ tool: ConfigurableTool; versionArgs: string[] }> = [
  { tool: "exiftool", versionArgs: ["-ver"] },
  { tool: "ffmpeg", versionArgs: ["-version"] },
  { tool: "ffprobe", versionArgs: ["-version"] },
  { tool: "imagemagick", versionArgs: ["-version"] },
  { tool: "qpdf", versionArgs: ["--version"] }
];

export type DoctorReport = { tool: ConfigurableTool; path: string; ok: boolean; version?: string };

function probeTool(binary: string, args: string[]) {
  return new Promise<string | null>((resolve) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? stdout.split("\n")[0].trim() : null));
  });
}

export async function runDoctor(io: CliIo = defaultIo) {
  const reports: DoctorReport[] = [];
  for (const { tool, versionArgs } of DOCTOR_TOOLS) {
    const binary = getToolPath(tool);
    const version = await probeTool(binary, versionArgs);
    reports.push({ tool, path: binary, ok: version !== null, version: version ?? undefined });
  }

  for (const report of reports) {
    io.log(report.ok ? `ok      ${report.tool} (${report.path}) — ${report.version}` : `MISSING ${report.tool} (looked for "${report.path}")`);
  }

  const missing = reports.filter((report) => !report.ok);
  if (missing.length > 0) {
    io.error("");
    io.error("Install the missing tools, e.g. on macOS:");
    io.error("  brew install exiftool ffmpeg imagemagick qpdf");
    io.error("or set EXIFTOOL_PATH / FFMPEG_PATH / FFPROBE_PATH / IMAGEMAGICK_PATH / QPDF_PATH.");
    return EXIT_USAGE;
  }

  return EXIT_OK;
}

export function packageMacosDir() {
  // dist/cli.js lives one level below the package root; macos/ ships in the
  // npm tarball via package.json "files".
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "macos");
}

export const QUICK_ACTION_NAME = "Clean with FreshFile.workflow";

export async function installFinderQuickAction(io: CliIo = defaultIo) {
  if (process.platform !== "darwin") {
    io.error("finder-install is only available on macOS.");
    return EXIT_USAGE;
  }

  const source = path.join(packageMacosDir(), QUICK_ACTION_NAME);
  try {
    await fs.access(source);
  } catch {
    io.error(`Quick Action template not found at ${source}.`);
    return EXIT_USAGE;
  }

  const target = path.join(os.homedir(), "Library", "Services", QUICK_ACTION_NAME);
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
  io.log(`Installed "${QUICK_ACTION_NAME.replace(".workflow", "")}" to ${target}.`);
  io.log("Right-click files in Finder → Quick Actions → Clean with FreshFile.");
  return EXIT_OK;
}

async function runBatch(
  files: string[],
  worker: (file: string) => Promise<FileReport>,
  json: boolean,
  render: (report: FileReport) => string,
  io: CliIo
) {
  const reports: FileReport[] = [];
  for (const file of files) {
    const report = await worker(file);
    reports.push(report);
    if (!json) {
      (report.ok ? io.log : io.error)(render(report));
    }
  }

  if (json) {
    io.log(JSON.stringify(reports, null, 2));
  }

  return reports.some((report) => !report.ok) ? EXIT_FILE_FAILED : EXIT_OK;
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let values: { "out-dir"?: string; prefix?: string; json?: boolean; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "out-dir": { type: "string", short: "o" },
        prefix: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" }
      }
    }));
  } catch (error) {
    io.error(describeError(error));
    io.error("");
    io.error(USAGE);
    return EXIT_USAGE;
  }

  const [command, ...files] = positionals;

  if (values.help || !command) {
    io.log(USAGE);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }

  const prefix = values.prefix ?? DEFAULT_PREFIX;
  const json = values.json === true;

  if (command === "clean") {
    if (files.length === 0) {
      io.error("clean needs at least one file.");
      return EXIT_USAGE;
    }
    return runBatch(
      files,
      (file) => cleanOne(file, prefix, values["out-dir"]),
      json,
      (report) =>
        report.ok
          ? `cleaned  ${report.file} → ${report.output} [${report.strategy}] removed ${summarizeRemoved(report)}`
          : `FAILED   ${report.file}: ${report.error}`,
      io
    );
  }

  if (command === "inspect") {
    if (files.length === 0) {
      io.error("inspect needs at least one file.");
      return EXIT_USAGE;
    }
    return runBatch(
      files,
      inspectOne,
      json,
      (report) =>
        report.ok
          ? `${report.file}: would remove ${summarizeRemoved(report)}`
          : `FAILED   ${report.file}: ${report.error}`,
      io
    );
  }

  if (command === "doctor") {
    return runDoctor(io);
  }

  if (command === "finder-install") {
    return installFinderQuickAction(io);
  }

  io.error(`Unknown command "${command}".`);
  io.error("");
  io.error(USAGE);
  return EXIT_USAGE;
}
