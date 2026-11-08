# Build context is this server/ directory (self-contained). Works on ARM64 out of the box as
# long as you build on-device (`docker compose build` on the Pi itself);
# use `docker buildx build --platform linux/arm64` if cross-building.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# journal.db and the Flask session secret are written here - mount a
# volume so they survive image rebuilds/container recreation.
ENV JOURNAL_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8420

# Single worker is required - see the note at the top of app.py.
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:8420", "app:app"]
