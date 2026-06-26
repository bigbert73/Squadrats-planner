FROM registry.access.redhat.com/ubi8/openjdk-17-runtime:latest

USER root

RUN mkdir -p /brouter-data/segments4 /brouter-data/profiles2 /opt/brouter

RUN microdnf install -y unzip && microdnf clean all

# Download BRouter release zip and copy entire distribution (preserves lib/ dir if present)
RUN curl -fsSL "https://api.github.com/repos/abrensch/brouter/releases/latest" \
      -H "Accept: application/vnd.github+json" \
      -o /tmp/release.json && \
    ZIP_URL=$(grep -o '"browser_download_url": *"[^"]*\.zip"' /tmp/release.json \
      | head -1 | grep -o 'https://[^"]*') && \
    echo "BRouter zip: $ZIP_URL" && \
    [ -n "$ZIP_URL" ] || { echo "ERROR: zip URL not found"; cat /tmp/release.json; exit 1; } && \
    curl -fL -o /tmp/brouter.zip "$ZIP_URL" && \
    unzip /tmp/brouter.zip -d /tmp/brouter-dist && \
    echo "=== ZIP contents ===" && find /tmp/brouter-dist | sort && \
    DIST_DIR=$(find /tmp/brouter-dist -name "brouter.jar" -exec dirname {} \; | head -1) && \
    [ -n "$DIST_DIR" ] || DIST_DIR=$(find /tmp/brouter-dist -maxdepth 1 -mindepth 1 -type d | head -1) && \
    [ -n "$DIST_DIR" ] || DIST_DIR=/tmp/brouter-dist && \
    echo "Copying from: $DIST_DIR" && \
    cp -r "$DIST_DIR"/. /opt/brouter/ && \
    echo "=== /opt/brouter ===" && ls -la /opt/brouter/ && \
    rm -rf /tmp/brouter.zip /tmp/brouter-dist /tmp/release.json

# Download routing profiles
RUN for p in fastbike fastbike-lowtraffic trekking safety shortest; do \
      curl -fL -o /brouter-data/profiles2/${p}.brf \
        "https://raw.githubusercontent.com/abrensch/brouter/master/misc/profiles2/${p}.brf" \
      && echo "OK: ${p}.brf" || echo "SKIP: ${p}.brf not found"; \
    done

# OCP: allow arbitrary UID
RUN chgrp -R 0 /brouter-data /opt/brouter && chmod -R g=u /brouter-data /opt/brouter

USER 1001

EXPOSE 17777

# Use -jar so MANIFEST.MF resolves Main-Class and Class-Path (lib/ dir support)
CMD ["sh", "-c", \
     "exec java -Xmx512m -Xms128m -jar /opt/brouter/brouter.jar \
      /brouter-data/segments4 /brouter-data/profiles2 /brouter-data/profiles2 17777 1"]
