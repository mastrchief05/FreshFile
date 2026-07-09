import { spawn } from "node:child_process";
import { getToolPath, MAX_TOOL_OUTPUT_BYTES } from "./config";

export type ExifToolResult = {
  stdout: string;
  stderr: string;
};

export type ExifToolRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<ExifToolResult>;

export class ExifToolError extends Error {
  constructor(
    message: string,
    public readonly reason: "failed" | "timeout" | "missing_binary",
    public readonly stderr?: string
  ) {
    super(message);
    this.name = "ExifToolError";
  }
}

export const defaultExifToolRunner: ExifToolRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const child = spawn(getToolPath("exiftool"), args, {
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
      reject(new ExifToolError("ExifTool timed out.", "timeout"));
    }, timeoutMs);

    // Legitimate ExifTool JSON for one file is kilobytes. Bounding the
    // accumulated output stops a crafted input (e.g. a PNG whose zTXt chunk
    // inflates to hundreds of MB of tag text) from OOM-ing the worker; the
    // wall-clock timeout alone does not bound memory.
    const guard = (chunk: string, append: (value: string) => void) => {
      if (settled) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > MAX_TOOL_OUTPUT_BYTES) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGKILL");
        reject(new ExifToolError("ExifTool produced too much output.", "failed"));
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
        reject(new ExifToolError("ExifTool is not installed or not available on PATH.", "missing_binary"));
      } else {
        reject(new ExifToolError("ExifTool failed to start.", "failed"));
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new ExifToolError("ExifTool failed to process the image.", "failed", stderr));
      }
    });
  });
