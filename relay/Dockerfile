# syntax=docker/dockerfile:1
#
# Cloud Run image for the team relay. The build context is multiagent/ (the schema lives
# beside relay/), so build it from there:
#
#   docker build -f relay/Dockerfile -t relay .
#
# scripts/deploy.sh builds it with Cloud Build (M2-SPEC §1). relay/Dockerfile.dockerignore
# keeps everything but the relay package and the manifest schema out of the context, local
# team configs included.
#
# The base image is pinned by digest (bump on purpose); the tag is
# kept beside it for a human to read. Bump on purpose.
#
# The image holds no team configuration and no credentials: RELAY_TEAM_CONFIG points at a
# file mounted at deploy, and Firestore is reached with the service account's ADC.

# python:3.12-slim
FROM python:3.12-slim@sha256:09f7da3bc104798d0afb40bc08d23ab2da20a76130cec1f2ef170848f5d85217
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    RELAY_HOST=0.0.0.0 \
    RELAY_MANIFEST_SCHEMA=/app/schema/manifest.schema.json

WORKDIR /app/relay
COPY relay/pyproject.toml ./
COPY relay/relay ./relay
RUN pip install --no-cache-dir .
COPY schema/manifest.schema.json /app/schema/manifest.schema.json

# Non-root; the relay writes nothing to disk.
RUN useradd --system --create-home --uid 10001 relay
USER relay

EXPOSE 8080
CMD ["python", "-m", "relay"]
