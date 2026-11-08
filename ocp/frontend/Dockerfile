# Build context must be the repo root (no contextDir in BuildConfig).
# nginxinc/nginx-unprivileged runs as UID 101 on port 8080 — OCP-compatible out of the box.
FROM nginxinc/nginx-unprivileged:alpine

USER root
COPY ocp/frontend/nginx.conf /etc/nginx/conf.d/default.conf
# The whole frontend, so new pages and scripts are never left out of the image.
COPY frontend/ /usr/share/nginx/html/
RUN rm -rf /usr/share/nginx/html/nginx.conf /usr/share/nginx/html/docs/tools
USER 101
