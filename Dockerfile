# Tool layer shared by the test and runtime stages.
# imagemagick provides `convert`, used to rewrite TIFFs (ExifTool cannot strip
# TIFF IFD0 tags). qpdf rebuilds PDFs after ExifTool so the incremental-update
# remnants (the original, recoverable metadata bytes) physically disappear.
# ExifTool is pinned from the official upstream tag: Debian bookworm ships
# 12.57, which cannot read ADTS AAC ("Unknown file type"). The pinned version
# matches what the test suite runs against.
FROM node:22-bookworm-slim AS tools
ENV EXIFTOOL_VERSION=13.59
ENV EXIFTOOL_SHA256=87d3317882fdae9cb4dcfe57a96a378d0132ffc02c731315bf128b19ddcf7aac
ENV EXIFTOOL_PATH=/opt/exiftool/exiftool
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl perl ffmpeg imagemagick qpdf \
  && curl -fsSL "https://github.com/exiftool/exiftool/archive/refs/tags/${EXIFTOOL_VERSION}.tar.gz" -o /tmp/exiftool.tar.gz \
  && echo "${EXIFTOOL_SHA256}  /tmp/exiftool.tar.gz" | sha256sum -c - \
  && mkdir -p /opt/exiftool \
  && tar -xzf /tmp/exiftool.tar.gz -C /opt/exiftool --strip-components=1 \
  && rm /tmp/exiftool.tar.gz \
  && /opt/exiftool/exiftool -ver \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

FROM tools AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY src ./src
COPY tests ./tests
RUN npm run typecheck && npm test && npm run build

# `docker build --target test .` runs the integration suite against the exact
# tool versions the runtime image ships.
FROM build AS test
RUN npm run test:integration

FROM build AS prod-deps
RUN npm prune --omit=dev

FROM tools AS runtime
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
RUN useradd --create-home --shell /usr/sbin/nologin freshfile
USER freshfile
# Mount files at /data: docker run --rm -v "$PWD:/data" <image> clean photo.jpg
WORKDIR /data
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
