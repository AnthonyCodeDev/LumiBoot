FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Implémentation officielle du protocole Wisp (voir README).
RUN python -m pip install --no-cache-dir "wisp-python==0.9.0" \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin wisp

USER 10001:10001
EXPOSE 8080
