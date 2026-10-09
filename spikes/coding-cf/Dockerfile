FROM oven/bun:1.4.2 AS bun
FROM node:22.18.0-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY repo/ .
RUN bun install --frozen-lockfile

COPY coding/ /spikes/coding/
RUN cd /spikes/coding && bun install --frozen-lockfile
COPY runner/ /spikes/coding-cf/runner/
COPY fixture/ /fixture/
RUN mkdir -p /state /execution \
  && chown 1000:1000 /state /execution \
  && chmod a+rx /repo /spikes /fixture /spikes/coding /spikes/coding-cf \
  && ln -s /spikes/coding/node_modules /spikes/coding-cf/node_modules
ENV HOME=/state TMPDIR=/state BUN_INSTALL_CACHE_DIR=/state/cache BUN_RUNTIME_TRANSPILER_CACHE_PATH=/state/transpiler
USER 1000:1000
WORKDIR /spikes/coding
CMD ["bun", "/spikes/coding-cf/runner/server.ts"]
