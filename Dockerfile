# KeySync web service: Next.js standalone + ffmpeg + yt-dlp.
# Transcription runs on a separate microservice (transcribe-service/); this
# container stays light so the 512MB free tier is plenty.
#
# Build:   docker build -t keysync .
# Run:     docker run -p 3000:10000 keysync
# Render:  connect the repo; render.yaml selects this Dockerfile automatically.

# ---- base: Node 20 + ffmpeg + yt-dlp ----
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# yt-dlp needs Python; transcription is a separate microservice, not in-process.
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# ---- builder: install deps and compile the Next.js app ----
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The runner stage copies /app/public; ensure it exists even though the repo has none.
RUN mkdir -p /app/public
RUN npm run build

# ---- runner: minimal production image ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# Standalone server (server.js) plus the static assets it serves.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Render injects PORT; default to 10000 for `docker run` parity.
ENV PORT=10000 HOSTNAME=0.0.0.0
EXPOSE 10000
CMD ["node", "server.js"]
