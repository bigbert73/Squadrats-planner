# Build context must be the repo root (no contextDir in BuildConfig).
# nginxinc/nginx-unprivileged runs as UID 101 on port 8080 — OCP-compatible out of the box.
FROM nginxinc/nginx-unprivileged:alpine

COPY ocp/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/index.html     /usr/share/nginx/html/
