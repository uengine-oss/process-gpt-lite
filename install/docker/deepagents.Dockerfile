# syntax=docker/dockerfile:1.7
# process-gpt deepagents for Process GPT Lite. Same steps as services/deepagents/Dockerfile
# (unchanged upstream), plus:
#   - the system skills come from the monorepo's skills/ (additional context `system-skills`)
#   - an entrypoint that runs the app from a path equal to the host data folder, so the sandbox
#     containers it starts on the host daemon can bind the same workspace (Docker-outside-of-Docker)
# Build context = services/deepagents; deepagents.Dockerfile.dockerignore keeps .env*, workspace
# and tenant skills out of the image.
FROM python:3.13-slim

ENV TZ=Asia/Seoul
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata curl gnupg build-essential git \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Node.js 20 + Supabase MCP (as upstream)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get update && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @supabase/mcp-server-supabase@latest \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm

WORKDIR /app
ENV PYTHONPATH=/app PIP_DEFAULT_TIMEOUT=300
RUN pip install --no-cache-dir uv
COPY requirements.txt ./
RUN uv pip install --system --no-cache -r requirements.txt

COPY . .
COPY --from=system-skills . /app/system-skills/process-gpt-system
COPY --from=install-docker deepagents-entrypoint.sh /usr/local/bin/deepagents-entrypoint.sh
RUN chmod +x /usr/local/bin/deepagents-entrypoint.sh

EXPOSE 8888
ENTRYPOINT ["/usr/local/bin/deepagents-entrypoint.sh"]
