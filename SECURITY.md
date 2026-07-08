# Security Policy

FreshFile is a privacy tool; reports about metadata that survives cleaning
are treated as security issues, not ordinary bugs.

## Reporting

Please **do not open a public issue** for security problems. Instead, use
GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"). You should receive a first
response within a few days.

Never attach private files to a report — reproduce with a synthetic sample,
e.g. `exiftool -Artist=test -GPSLatitude=48.1 sample.jpg`.

## Scope

- The `freshfile` npm package (engine, CLI, browser entry)
- The published Docker image (`ghcr.io/mastrchief05/freshfile`)
- The Homebrew formula in `mastrchief05/homebrew-tap`

The freshfile.io website is a separate, private codebase; issues that only
affect the hosted service can be reported the same way.

## Supported versions

Only the latest released version receives fixes.
