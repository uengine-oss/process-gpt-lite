# syntax=docker/dockerfile:1.7
# ArtCraft for the install bundle (artcraft/README.md, ./install.sh --with-craft): each app's web
# editor and MCP CLI built from the tested upstream commit with our patches (Hangul face, page
# API). The last stage only holds /craft/{web/<app>,bin}; the `craft` service copies them into
# the server's /data volume and exits.
# Build context = artcraft/ (patches, fonts-ko).

ARG RUST_IMAGE=rust:1-bookworm

FROM ${RUST_IMAGE} AS toolchain
# rustc jobs per app: wasm builds need ~1GB each, and the stack keeps running beside the build
ARG CRAFT_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends zip unzip \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown \
 && cargo install trunk --locked --version 0.22.1
# NanumGothic (SIL OFL 1.1), compiled into the web builds so Hangul is not tofu
ADD --checksum=sha256:76f45ef4a6bcff344c837c95a7dcc26e017e38b5846d5ae0cdcb5b86be2e2d31 \
    https://github.com/google/fonts/raw/main/ofl/nanumgothic/NanumGothic-Regular.ttf /fonts-ko/fonts/NanumGothic-Regular.ttf
COPY fonts-ko/fonts/manifest.txt /fonts-ko/fonts/
COPY patches /patches
COPY --from=install-docker --chmod=755 craft-build.sh /usr/local/bin/craft-build
# CRAFT_FONTS_DIR is the folder holding fonts/manifest.txt (CADCraft · VectorCraft build.rs)
ENV PGPT_KO_FONT=/fonts-ko/fonts/NanumGothic-Regular.ttf \
    CRAFT_FONTS_DIR=/fonts-ko \
    CARGO_BUILD_JOBS=${CRAFT_JOBS} \
    CARGO_TARGET_DIR=/target

# the tested commits (artcraft/README.md); each stage builds on the previous one so BuildKit runs
# them one at a time instead of five wasm builds at once
FROM toolchain AS cadcraft
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,id=craft-cadcraft,target=/target \
    craft-build cadcraft b9f96d3dd3630a8de2cb7885d66ded334682918b
FROM cadcraft AS vectorcraft
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,id=craft-vectorcraft,target=/target \
    craft-build vectorcraft 75dacb4fec73dac539538c91f92d41e09b255d23
FROM vectorcraft AS photocraft
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,id=craft-photocraft,target=/target \
    craft-build photocraft 1c3db2e5c35a4f8c544011e57c8026ccb9741926
FROM photocraft AS soundcraft
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,id=craft-soundcraft,target=/target \
    craft-build soundcraft 93800e0764ca62435ee66a4770f355df954b7fcd
FROM soundcraft AS filmcraft
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,id=craft-filmcraft,target=/target \
    craft-build filmcraft 057f460085c6c1c1f2335f1ba1c599a2ff36da67

FROM debian:bookworm-slim AS craft
COPY --from=filmcraft /out/ /craft/
# web editors under /data/craft (served at /craft/<app>/), CLIs beside it, not under the web root
CMD ["sh", "-c", "set -e; for a in /craft/web/*; do rm -rf /data/craft/$(basename $a); cp -a $a /data/craft/; done; mkdir -p /data/craft-bin; cp -a /craft/bin/. /data/craft-bin/; ls /data/craft /data/craft-bin"]
