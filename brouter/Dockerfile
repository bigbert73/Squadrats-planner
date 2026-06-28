FROM registry.access.redhat.com/ubi8/openjdk-17-runtime:latest

USER root

RUN mkdir -p /brouter-data/segments4 /opt/brouter

RUN microdnf install -y unzip && microdnf clean all

# Download BRouter release zip — profiles2/ and lib/ are bundled inside
RUN curl -fsSL "https://api.github.com/repos/abrensch/brouter/releases/latest" \
      -H "Accept: application/vnd.github+json" \
      -o /tmp/release.json && \
    ZIP_URL=$(grep -o '"browser_download_url": *"[^"]*\.zip"' /tmp/release.json \
      | head -1 | grep -o 'https://[^"]*') && \
    echo "BRouter zip: $ZIP_URL" && \
    [ -n "$ZIP_URL" ] || { echo "ERROR: zip URL not found"; cat /tmp/release.json; exit 1; } && \
    curl -fL -o /tmp/brouter.zip "$ZIP_URL" && \
    unzip /tmp/brouter.zip -d /tmp/brouter-dist && \
    DIST_DIR=$(find /tmp/brouter-dist -maxdepth 1 -mindepth 1 -type d | head -1) && \
    cp -r "$DIST_DIR"/. /opt/brouter/ && \
    mv "$(find /opt/brouter -maxdepth 1 -name 'brouter-*-all.jar' | head -1)" /opt/brouter/brouter.jar && \
    echo "=== /opt/brouter ===" && ls -la /opt/brouter/ && \
    rm -rf /tmp/brouter.zip /tmp/brouter-dist /tmp/release.json

# Custom profiles: trunk=forbidden(10000) for Polish expressways (S61 etc.)
COPY rowery-pl.brf /opt/brouter/profiles2/rowery-pl.brf
COPY safety.brf    /opt/brouter/profiles2/safety.brf

# OCP: allow arbitrary UID
RUN chgrp -R 0 /brouter-data /opt/brouter && chmod -R g=u /brouter-data /opt/brouter

USER 1001

EXPOSE 17777

# Use -cp with lib/* so all dependencies are on classpath, then call RouteServer directly.
# Cannot use -jar: manifest Main-Class is BRouter (CLI mode), not RouteServer (HTTP server).
CMD ["sh", "-c", \
     "exec java -Xmx768m -Xms256m -cp '/opt/brouter/brouter.jar:/opt/brouter/lib/*' \
      btools.server.RouteServer \
      /brouter-data/segments4 /opt/brouter/profiles2 /opt/brouter/profiles2 17777 60"]
