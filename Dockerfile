# KeySync production image: Next.js standalone + Python (Basic Pitch) + ffmpeg + yt-dlp.
#
# Build:   docker build -t keysync .
# Run:     docker run -p 3000:10000 keysync
# Render:  connect the repo; render.yaml selects this Dockerfile automatically.

# ---- base: Node 20 + Python 3 + ffmpeg + yt-dlp + basic-pitch ----
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg ca-certificates libsndfile1 \
 && rm -rf /var/lib/apt/lists/*
# basic-pitch runs on the ONNX backend (no TensorFlow needed).
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp basic-pitch
ENV PYTHON_BIN=python3

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
# Transcription script, invoked by /api/build via PYTHON_BIN (not bundled by Next).
COPY --from=builder /app/scripts ./scripts
# Render injects PORT; default to 10000 for `docker run` parity.
ENV PORT=10000 HOSTNAME=0.0.0.0
EXPOSE 10000
CMD ["node", "server.js"]
