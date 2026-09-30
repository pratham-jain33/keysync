# KeySync transcription microservice: Python + ffmpeg + basic-pitch (ONNX).
# Runs as its own Render service so the 512MB RAM is dedicated to the ML
# stack. Single-threaded native libs to keep the memory footprint small.
FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
EXPOSE 8000
CMD ["python", "app.py"]
