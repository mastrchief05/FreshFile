# FreshFile

Remove metadata from images, videos, audio, PDFs and office documents —
without changing what people see or hear. This is the open-source engine
that powers [freshfile.io](https://freshfile.io): the exact same code the
website runs, published so you can verify it, run it locally, and build on it.

- **Private by design** — files are processed on your machine; nothing is uploaded anywhere.
- **No size limits** — the hosted service caps uploads, your machine doesn't.
- **Originals untouched** — cleaning always writes a `fresh_` copy next to the source.

## Install (macOS)

```sh
brew tap mastrchief05/tap
brew trust mastrchief05/tap   # newer Homebrew asks once per third-party tap
brew install freshfile
```

Everything included: Homebrew pulls ExifTool, FFmpeg, ImageMagick and qpdf
along with the CLI. Then:

```sh
freshfile clean vacation.jpg          # writes fresh_vacation.jpg next to it
freshfile inspect vacation.jpg        # dry run: shows what would be removed
freshfile finder-install              # adds "Clean with FreshFile" to Finder's right-click menu
freshfile doctor                      # checks the toolchain
```

## Install (npm)

```sh
npm install -g freshfile     # or: npx freshfile clean photo.jpg
```

The npm route expects the external tools on your PATH. On macOS:
`brew install exiftool ffmpeg imagemagick qpdf` — `freshfile doctor` tells
you what's missing. You can also point the CLI at specific binaries via
`EXIFTOOL_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`, `IMAGEMAGICK_PATH`, `QPDF_PATH`.

## Install (Docker)

Everything bundled, runs anywhere:

```sh
docker run --rm -v "$PWD:/data" ghcr.io/mastrchief05/freshfile clean photo.jpg
```

## Downloads from GitHub Releases

Each release also attaches the npm tarball. Note for macOS: binaries and
scripts downloaded through a browser carry the quarantine flag and Gatekeeper
will warn on first run ("developer cannot be verified" — right-click → Open).
Installs via `brew`, `npm` or `curl` are not affected; prefer those.

## CLI

```
freshfile clean <files...>    Write a cleaned copy of each file
freshfile inspect <files...>  Dry run: report what a clean would remove
freshfile doctor              Verify the external toolchain
freshfile finder-install      Install the macOS Finder Quick Action

  -o, --out-dir <dir>  Write cleaned files into <dir> instead of next to the source
      --prefix <p>     Output filename prefix (default: "fresh_")
      --json           Machine-readable per-file reports
```

Exit codes: `0` everything cleaned, `1` at least one file failed, `2` usage
or configuration error. Existing `fresh_` copies from earlier runs are
overwritten; originals never are.

## Library

```ts
import { cleanFile, validateUploadedFile, configureFreshfile } from "freshfile";

configureFreshfile({ maxUploadBytes: 25 * 1024 * 1024 }); // optional; default: unlimited

const upload = await validateUploadedFile(buffer, "photo.jpg");
const result = await cleanFile(upload, originalPath, cleanedPath);
// result.strategy, result.removedCategories, result.removedFieldCount
```

Browser-side cleaning — no server round-trip, files never leave the device:

```ts
import { cleanImageInBrowser, cleanMediaInBrowser, cleanDocumentInBrowser } from "freshfile/browser";

const bytes = new Uint8Array(await file.arrayBuffer());
cleanImageInBrowser(bytes);                  // JPEG, PNG, WebP
cleanMediaInBrowser(bytes, file.name);       // GIF, MP3, FLAC
cleanDocumentInBrowser(bytes, file.name);    // DOCX/XLSX/PPTX, ODT/ODS/ODP, EPUB, SVG, RTF, TXT/MD/CSV
```

All browser cleaners are deterministic byte/package surgery and **fail
closed**: anything unexpected throws so callers can fall back to a server
running the full engine with ExifTool re-validation. The integration suite
re-inspects browser-cleaner output with ExifTool on every CI run.

## How files are cleaned

| Formats | Strategy |
| --- | --- |
| JPEG, PNG, WebP (also in-browser) | Byte-level segment surgery — EXIF/XMP/APP markers stripped, pixels untouched |
| GIF (also in-browser) | Extension-block surgery — comments/XMP dropped, animation loop kept |
| MP3, FLAC (also in-browser) | Tag-block surgery — ID3/APE/Lyrics3/Vorbis comments and cover art dropped, audio frames untouched |
| JPEG, PNG, GIF, HEIC, AVIF, WebP | ExifTool `-all=`, then re-inspection of the output |
| TIFF | ImageMagick rewrite (ExifTool cannot drop IFD0 tags), color profile restored |
| MP4, MOV, M4V, M4A | ExifTool metadata strip + timestamp zeroing |
| WebM, MKV, AVI, MP3, FLAC, WAV, OGG, Opus | FFmpeg stream copy — no transcoding, no quality loss |
| PDF | ExifTool, then a full qpdf rewrite so removed metadata is not recoverable |
| DOCX, XLSX, PPTX, ODT, ODS, ODP, EPUB (also in-browser) | ZIP rewrite with XML sanitization |
| SVG (also in-browser) | XML parse, metadata/script/comment nodes dropped |
| TXT, MD, CSV (also in-browser) | Byte-for-byte copy (validated to carry no metadata) |

Every clean is followed by a validation pass: the output is re-inspected and
the clean **fails loudly** rather than shipping a file that still carries
sensitive fields or lost visual integrity.

Document packages get a second, independent validation layer on top of the
ExifTool inspection: `verifyCleanedOfficeBytes` re-derives from the bytes
alone — with its own ZIP parser and its own per-format policy — that the
cleaned package contains exactly the structure the cleaner guarantees (no
forbidden parts, empty property parts, epoch timestamps, no foreign bytes
hiding between entries). ExifTool degrades gracefully when an environment
lacks one of its optional capabilities; this layer exists so that a blind
inspector can never silently weaken the validation. It runs on the server and
in the browser.

### Why ExifTool is pinned

The Docker image installs ExifTool 13.59 from the official upstream tag
(checksum-verified) instead of the distro package: Debian bookworm ships
12.57, which cannot read ADTS AAC files. CI runs the integration suite inside
the image, so the tests exercise exactly the tool versions that ship.

## Development

```sh
npm ci
npm test                  # unit tests (no external tools needed)
npm run test:integration  # needs exiftool/ffmpeg/imagemagick/qpdf installed
npm run build
```

## License

[MIT](LICENSE). Extracted from the FreshFile app; the freshfile.io website
itself (UI, branding) is a separate, proprietary codebase that consumes this
package.
