FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home processor
WORKDIR /app
COPY processor/main.py /app/main.py
USER processor
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/app/main.py"]
