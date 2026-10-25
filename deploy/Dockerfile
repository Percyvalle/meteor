# Relay image.
#
# Only the relay is containerized. The streamer's local host serves the overlay to
# OBS on their own machine and has no business in Docker.
#
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t meteor-relay .

FROM node:24-alpine

WORKDIR /app

# No dependencies and no build step — the relay is plain ESM on Node builtins.
COPY relay ./relay
COPY server/log.mjs ./server/log.mjs
COPY package.json ./package.json

# State lives on a volume; the project directory is ephemeral.
ENV RELAY_STATE_FILE=/data/relay-state.json \
    RELAY_PORT=8088 \
    RELAY_HOST=0.0.0.0 \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8088

# Fails the container if the relay stops answering, so the restart policy can act.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8088)+'/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay/index.mjs"]
