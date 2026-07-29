# syntax=docker/dockerfile:1.7
FROM node:22.17.1-bookworm-slim AS node
FROM rust:1.88.0-bookworm

COPY --from=node /usr/local/ /usr/local/

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential \
      curl \
      file \
      libayatana-appindicator3-dev \
      libfuse2 \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      patchelf \
      rpm

ENV APPIMAGE_EXTRACT_AND_RUN=1
ENV CARGO_TARGET_DIR=/build/target

COPY --chmod=0755 build/docker/linux/build.sh /usr/local/bin/anchor-build-linux

ENTRYPOINT ["/usr/local/bin/anchor-build-linux"]
