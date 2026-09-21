ARG BASE_REGISTRY=docker.io/library
FROM ${BASE_REGISTRY}/node:22.23.2-bookworm-slim AS frontend
WORKDIR /ui
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
FROM ${BASE_REGISTRY}/python:3.13.15-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data STATIC_DIR=/app/static HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libxrender1 libxext6 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=frontend /ui/dist ./static
# Source files edited on the host may carry 0600 permissions; the service runs as an unprivileged user.
RUN chmod -R a+rX /app && useradd --uid 10001 --create-home forge && mkdir -p /data && chown forge:forge /data
USER forge
EXPOSE 8100
CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8100"]
