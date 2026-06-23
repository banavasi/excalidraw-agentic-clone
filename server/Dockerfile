FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install the package + deps. (fleet-obs is optional and wired at deploy.)
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .

EXPOSE 8789

# Bind 0.0.0.0 INSIDE the container only — the host publishes this port via
# docker-compose as 127.0.0.1:8789 + the tailnet IP, never 0.0.0.0 on the host.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8789"]
