import { spawn } from "node:child_process";
import { getToolPath, MAX_TOOL_OUTPUT_BYTES } from "./config";

export type ToolResult = {
  stdout: string;
  stderr: string;
};

export type ToolRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<ToolResult>;

type MediaTool = "ffmpeg" | "ffprobe" | "imagemagick" | "qpdf";

export class MediaToolError extends Error {
  constructor(
    message: string,
    public readonly tool: MediaTool,
    public readonly reason: "failed" | "timeout" | "missing_binary",
    public readonly stderr?: string
  ) {
    super(message);
    this.name = "MediaToolError";
  }
}

function runTool(tool: MediaTool, binaryPath: string, args: string[], timeoutMs: number) {
  return new Promise<ToolResult>((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let settled = false;

    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new MediaToolError(`${tool} timed out.`, tool, "timeout"));
    }, timeoutMs);

    // Bound accumulated output so a crafted input that makes the tool spew
    // hundreds of MB (e.g. per-packet ffmpeg warnings) cannot OOM the worker;
    // the timeout bounds only wall-clock, not memory.
    const guard = (chunk: string, append: (value: string) => void) => {
      if (settled) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > MAX_TOOL_OUTPUT_BYTES) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGKILL");
        reject(new MediaToolError(`${tool} produced too much output.`, tool, "failed"));
        return;
      }
      append(chunk);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => guard(chunk, (value) => (stdout += value)));
    child.stderr.on("data", (chunk: string) => guard(chunk, (value) => (stderr += value)));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(new MediaToolError(`${tool} is not installed or not available on PATH.`, tool, "missing_binary"));
      } else {
        reject(new MediaToolError(`${tool} failed to start.`, tool, "failed"));
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new MediaToolError(`${tool} failed.`, tool, "failed", stderr));
      }
    });
  });
}

export const defaultFfmpegRunner: ToolRunner = (args, options = {}) =>
  runTool("ffmpeg", getToolPath("ffmpeg"), args, options.timeoutMs ?? 120_000);

export const defaultFfprobeRunner: ToolRunner = (args, options = {}) =>
  runTool("ffprobe", getToolPath("ffprobe"), args, options.timeoutMs ?? 30_000);

export const defaultImageMagickRunner: ToolRunner = (args, options = {}) =>
  runTool("imagemagick", getToolPath("imagemagick"), args, options.timeoutMs ?? 60_000);

export const defaultQpdfRunner: ToolRunner = (args, options = {}) =>
  runTool("qpdf", getToolPath("qpdf"), args, options.timeoutMs ?? 30_000);
