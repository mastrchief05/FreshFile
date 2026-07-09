import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanOne, inspectOne, outputPathFor, runCli, DEFAULT_PREFIX, EXIT_FILE_FAILED, EXIT_OK, EXIT_USAGE } from "@/cli/cli-core";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', "utf8");

function collectIo() {
  const lines: string[] = [];
  return {
    io: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) },
    lines
  };
}

describe("cli", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "freshfile-cli-"));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("builds output paths next to the source by default", () => {
    expect(outputPathFor("/photos/trip.jpg", DEFAULT_PREFIX)).toBe("/photos/fresh_trip.jpg");
    expect(outputPathFor("/photos/trip.jpg", "clean-", "/out")).toBe("/out/clean-trip.jpg");
  });

  it("shows usage and fails without a command", async () => {
    const { io } = collectIo();
    expect(await runCli([], io)).toBe(EXIT_USAGE);
  });

  it("exits ok for --help", async () => {
    const { io, lines } = collectIo();
    expect(await runCli(["--help"], io)).toBe(EXIT_OK);
    expect(lines.join("\n")).toContain("freshfile clean");
  });

  it("rejects unknown commands and unknown flags", async () => {
    const { io } = collectIo();
    expect(await runCli(["frobnicate"], io)).toBe(EXIT_USAGE);
    expect(await runCli(["clean", "--frobnicate", "x.png"], io)).toBe(EXIT_USAGE);
  });

  it("requires files for clean and inspect", async () => {
    const { io } = collectIo();
    expect(await runCli(["clean"], io)).toBe(EXIT_USAGE);
    expect(await runCli(["inspect"], io)).toBe(EXIT_USAGE);
  });

  it("reports a missing file as a failure with exit code 1", async () => {
    const { io } = collectIo();
    expect(await runCli(["clean", path.join(workDir, "nope.png")], io)).toBe(EXIT_FILE_FAILED);
  });

  it("cleans an SVG end-to-end without external tools", async () => {
    const input = path.join(workDir, "icon.svg");
    await fs.writeFile(input, svgBytes);

    const report = await cleanOne(input, DEFAULT_PREFIX);
    expect(report.ok).toBe(true);
    expect(report.strategy).toBe("svg-sanitize");
    expect(report.output).toBe(path.join(workDir, "fresh_icon.svg"));

    const cleaned = await fs.readFile(report.output!, "utf8");
    expect(cleaned).toContain("<svg");
    // The original is untouched.
    expect(await fs.readFile(input)).toEqual(svgBytes);
  });

  it("honors --out-dir and --prefix", async () => {
    const input = path.join(workDir, "icon.svg");
    const outDir = path.join(workDir, "out");
    await fs.writeFile(input, svgBytes);

    const { io } = collectIo();
    expect(await runCli(["clean", input, "-o", outDir, "--prefix", "clean-"], io)).toBe(EXIT_OK);
    await expect(fs.access(path.join(outDir, "clean-icon.svg"))).resolves.toBeUndefined();
  });

  it("emits machine-readable reports with --json", async () => {
    const input = path.join(workDir, "icon.svg");
    await fs.writeFile(input, svgBytes);

    const { io, lines } = collectIo();
    expect(await runCli(["clean", input, "--json"], io)).toBe(EXIT_OK);
    const reports = JSON.parse(lines.join("\n"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ok: true, strategy: "svg-sanitize" });
  });

  it("does not cap local file sizes", async () => {
    const input = path.join(workDir, "big.txt");
    await fs.writeFile(input, Buffer.concat([Buffer.from("hello "), Buffer.alloc(30 * 1024 * 1024, 97)]));

    const report = await cleanOne(input, DEFAULT_PREFIX);
    expect(report.ok).toBe(true);
    expect(report.strategy).toBe("copy-no-metadata");
  });

  it("inspect reports plain text as metadata-free without touching tools", async () => {
    const input = path.join(workDir, "notes.txt");
    await fs.writeFile(input, "hello");

    const report = await inspectOne(input);
    expect(report).toMatchObject({ ok: true, removedFieldCount: 0 });
  });

  it("continues after a failure and still cleans the rest", async () => {
    const good = path.join(workDir, "icon.svg");
    await fs.writeFile(good, svgBytes);
    const missing = path.join(workDir, "missing.png");

    const { io } = collectIo();
    expect(await runCli(["clean", missing, good], io)).toBe(EXIT_FILE_FAILED);
    await expect(fs.access(path.join(workDir, "fresh_icon.svg"))).resolves.toBeUndefined();
  });

  it("rejects a file whose extension does not match its content", async () => {
    const input = path.join(workDir, "sneaky.pdf");
    await fs.writeFile(input, pngBytes);

    const report = await cleanOne(input, DEFAULT_PREFIX);
    expect(report.ok).toBe(false);
  });
});
