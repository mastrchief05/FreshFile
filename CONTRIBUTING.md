# Contributing

Thanks for your interest in improving FreshFile!

## Ground rules

- **Safety over convenience.** The engine's contract is: either the output is
  verifiably clean and visually identical, or the clean fails loudly. Changes
  that trade validation for speed or format coverage will be declined.
- **Format support PRs need integration tests.** A new format must come with
  a case in `tests/integration/` that cleans a real sample and re-inspects
  the output. Unit tests alone are not enough — the external tools are where
  formats break.
- **No new runtime dependencies without discussion.** The package ships with
  three; every addition widens the supply-chain surface of a privacy tool.

## Getting started

```sh
npm ci
npm test                  # unit tests, no external tools required
brew install exiftool ffmpeg imagemagick qpdf   # or your distro's packages
npm run test:integration  # runs against the real tools
```

`npm run typecheck` and `npm test` must pass before a PR; CI also runs the
integration suite inside the Docker image with the pinned tool versions.

## Reporting issues

- **A file that doesn't clean:** please attach the `freshfile inspect --json`
  output and the exact error — but **never upload a private file**. Reproduce
  with a synthetic file if you can (e.g. created via `exiftool -Artist=x`).
- **Security issues:** please do not open a public issue. Use GitHub's
  private vulnerability reporting instead — see [SECURITY.md](SECURITY.md).
