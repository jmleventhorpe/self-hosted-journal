# Build context is this server/ directory (self-contained). Works on ARM64 out of the box as
# long as you build on-device (`docker compose build` on the Pi itself);
# use `docker buildx build --platform linux/arm64` if cross-building.
FROM python:3.12-slim

WORKDIR /app

# The server runs as this unprivileged user, not root (see entrypoint.py).
# The app's own files stay root-owned, so it can't modify its own code.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin journal
# No point trying to write .pyc files into the root-owned /app.
ENV PYTHONDONTWRITEBYTECODE=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# journal.db and the Flask session secret are written here - mount a
# volume so they survive image rebuilds/container recreation.
ENV JOURNAL_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8420

# Starts as root just to hand /data to the journal user, then drops to it.
ENTRYPOINT ["python", "/app/entrypoint.py"]
# Single worker is required - see the note at the top of app.py.
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:8420", "app:app"]
