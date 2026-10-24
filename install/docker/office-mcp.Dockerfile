# syntax=docker/dockerfile:1.7
# process-gpt office-mcp for Process GPT Lite: upstream steps (services/office-mcp/Dockerfile)
# with an ignore file that keeps .env and logs out, and the loopback forward used by the
# public-URL storage links (see pgpt-entrypoint.sh).
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl socat \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
COPY --from=install-docker pgpt-entrypoint.sh /usr/local/bin/pgpt-entrypoint.sh
EXPOSE 1192
ENTRYPOINT ["/usr/local/bin/pgpt-entrypoint.sh"]
CMD ["python", "main.py"]
