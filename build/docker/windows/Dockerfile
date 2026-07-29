# syntax=docker/dockerfile:1.7
FROM node:22.17.1-bookworm-slim AS node
FROM rust:1.89.0-bookworm

COPY --from=node /usr/local/ /usr/local/

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential \
      clang \
      curl \
      file \
      libayatana-appindicator3-dev \
      libclang-dev \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      lld \
      llvm \
      nsis \
      patchelf

RUN rustup target add x86_64-pc-windows-msvc \
    && cargo install --locked cargo-xwin --version 0.23.0

ENV CARGO_TARGET_DIR=/build/target
ENV XWIN_CACHE_DIR=/xwin-cache

COPY --chmod=0755 build/docker/windows/build.sh /usr/local/bin/anchor-build-windows

ENTRYPOINT ["/usr/local/bin/anchor-build-windows"]
