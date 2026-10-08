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
WORKDIR /spikes/coding
CMD ["bun", "/spikes/coding-cf/runner/server.ts"]
