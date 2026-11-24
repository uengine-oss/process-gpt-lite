# syntax=docker/dockerfile:1.7
# Process GPT Lite (pgpt-pro): two images from the pgpt-pro source tree
#   target web    — the Vue SPA built with `vite build`, served by nginx with the same routes the
#                   Vite dev server proxies today (/api + websockets, /office, /craft) plus the
#                   Supabase API paths (/auth/v1, /rest/v1, /storage/v1) on the same origin
#   target server — the Node BFF (server/), headless Chromium for the browser agent
# Build context = pgpt-pro root. What enters the context is whitelisted in
# pgpt.Dockerfile.dockerignore (no .env, keys, recordings, docs, android).

ARG NODE_IMAGE=node:22-bookworm-slim
# the address link previews name (index.html og:image, og:url): written at build, swapped per request by nginx
ARG LITE_PUBLIC_ORIGIN=https://uengine.process-gpt.io

# ---------- SPA ----------
FROM ${NODE_IMAGE} AS web-build
WORKDIR /src
COPY package.json package-lock.json ./
# node-pty (root package.json) is only used by the server; skip native builds here
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
# '/lite/' for the image behind the ProcessGPT gateway (<tenant>.process-gpt.io/lite); see src/base.js
ARG VITE_BASE_PATH=/
ARG LITE_PUBLIC_ORIGIN
RUN VITE_BASE_PATH=$VITE_BASE_PATH LITE_PUBLIC_ORIGIN=$LITE_PUBLIC_ORIGIN npx vite build

FROM nginx:1.27-alpine AS web
ARG LITE_PUBLIC_ORIGIN
COPY --from=web-build /src/dist /usr/share/nginx/html
COPY --from=install-docker nginx.conf /etc/nginx/templates/default.conf.template
ENV LITE_RESOLVER=127.0.0.11 \
    LITE_SERVER=server:8787 \
    LITE_OFFICE_HOST=office-host:5390 \
    LITE_KONG=kong:8000 \
    LITE_PUBLIC_ORIGIN=${LITE_PUBLIC_ORIGIN}
EXPOSE 80

# ---------- BFF dependencies (native modules need a toolchain) ----------
FROM ${NODE_IMAGE} AS server-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# lib/workroom.js imports node-pty, declared in the root package.json
RUN npm install --no-save --no-audit --no-fund node-pty@1.0.0

# ---------- BFF ----------
FROM ${NODE_IMAGE} AS server
ARG WITH_BROWSER=1
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# git: shared folders are git repositories; zip: mission skill bundles; socat: loopback forward;
# lsof: ArtCraft live editing checks which pid holds the bridge socket; fonts-nanum: the face
# the agent is told to use in ArtCraft files (the headless CLIs render with system fonts);
# poppler-utils: pdftotext / pdfinfo for the text of a shared folder's PDFs (lib/folders/indexer.js)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git zip socat ca-certificates tini curl lsof fonts-nanum poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.name "Process GPT" \
 && git config --system user.email "noreply@pgpt-lite.local" \
 && git config --system init.defaultBranch main
# yt-dlp: YouTube transcripts and video details (mcp/connectors/youtube.js). The standalone release
# binary (this image has no Python); it runs YouTube's player script with the image's node.
ARG YTDLP_VERSION=2026.10.26
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in arm64) f=yt-dlp_linux_aarch64 ;; *) f=yt-dlp_linux ;; esac \
 && curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${f}" \
 && chmod +x /usr/local/bin/yt-dlp \
 && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf \
 && yt-dlp --version
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
# headless shell only (the browser agent launches headless); ~300MB with its system libraries
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      npx --yes playwright install --with-deps --only-shell chromium \
      && rm -rf /var/lib/apt/lists/* /root/.npm; \
    fi
COPY server/ ./
COPY skills /app/skills
COPY --from=install-docker pgpt-entrypoint.sh /usr/local/bin/pgpt-entrypoint.sh
RUN chmod +x /usr/local/bin/pgpt-entrypoint.sh \
 && mkdir -p /data/folders /data/craft /data/browser-profiles \
 && ln -sfn /data/browser-profiles /app/server/.browser-profiles
EXPOSE 8787
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pgpt-entrypoint.sh"]
CMD ["node", "index.js"]
