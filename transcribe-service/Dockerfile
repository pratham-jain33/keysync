# KeySync transcription microservice: Python + ffmpeg + Kong's high-resolution
# piano transcription model (PyTorch, CPU).
# Runs as its own Render service so the 512MB RAM is dedicated to the ML
# stack. Single-threaded native libs to keep the memory footprint small.
FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
# CPU-only torch: far smaller than the default CUDA build.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch
RUN pip install --no-cache-dir -r requirements.txt
# Bake the ~172MB checkpoint into the image. The package's own downloader
# (wget against an old Zenodo URL pattern) no longer works, so fetch the
# file directly to the exact path the package expects. The size check fails
# the build loudly if Zenodo ever serves an error page instead.
RUN mkdir -p /root/piano_transcription_inference_data && \
    curl -sSL --retry 3 \
      -o /root/piano_transcription_inference_data/note_F1=0.9677_pedal_F1=0.9186.pth \
      "https://zenodo.org/api/records/4034264/files/CRNN_note_F1=0.9677_pedal_F1=0.9186.pth/content" && \
    test $(stat -c%s /root/piano_transcription_inference_data/note_F1=0.9677_pedal_F1=0.9186.pth) -gt 160000000
COPY app.py .
EXPOSE 8000
CMD ["python", "app.py"]
