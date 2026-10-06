# syntax=docker/dockerfile:1
 
# Distroless: no shell, no package manager, no npm, runs as UID 65532.
# For reproducible builds, pin the digest, e.g.:
#   FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:<digest>
FROM gcr.io/distroless/nodejs26-debian13:nonroot
 
LABEL org.opencontainers.image.title="improvmx-to-loki" \
      org.opencontainers.image.description="Receives ImprovMX webhooks and pushes emails to Grafana Loki"
 
ENV NODE_ENV=production \
    PORT=8080
 
WORKDIR /app
 
# Owned by root and read-only, so the runtime user cannot modify the script.
COPY --chown=0:0 --chmod=0444 improvmx-to-loki.js /app/improvmx-to-loki.js
 
USER 65532:65532
 
EXPOSE 8080
 
# No shell or curl in the image, so the healthcheck uses Node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
 
ENTRYPOINT ["/nodejs/bin/node", "--disable-proto=delete", "/app/improvmx-to-loki.js"]
