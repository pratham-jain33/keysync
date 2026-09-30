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
# basic-pitch needs --no-deps: its tensorflow pin has no Python 3.12 wheels,
# and it runs fine on onnxruntime alone (see requirements.txt).
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps basic-pitch==0.4.0
COPY app.py .
EXPOSE 8000
CMD ["python", "app.py"]
