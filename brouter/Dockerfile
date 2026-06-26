FROM registry.access.redhat.com/ubi8/openjdk-17-runtime:latest

USER root

RUN mkdir -p /brouter-data/segments4 /brouter-data/profiles2 /opt/brouter

# unzip is needed to extract the BRouter release archive
RUN microdnf install -y unzip && microdnf clean all

# BRouter releases a zip, not a standalone jar.
# GitHub API JSON has spaces: "browser_download_url": "https://..."
RUN curl -fsSL "https://api.github.com/repos/abrensch/brouter/releases/latest" \
      -H "Accept: application/vnd.github+json" \
      -o /tmp/release.json && \
    echo "--- GitHub API response (first 3 lines) ---" && \
    head -3 /tmp/release.json && \
    ZIP_URL=$(grep -o '"browser_download_url": *"[^"]*\.zip"' /tmp/release.json \
      | head -1 | grep -o 'https://[^"]*') && \
    echo "BRouter zip URL: $ZIP_URL" && \
    [ -n "$ZIP_URL" ] || { echo "ERROR: zip URL not found"; cat /tmp/release.json; exit 1; } && \
    curl -fL -o /tmp/brouter.zip "$ZIP_URL" && \
    unzip /tmp/brouter.zip -d /tmp/brouter-dist && \
    JAR_PATH=$(find /tmp/brouter-dist -name "*.jar" | head -1) && \
    echo "Copying JAR: $JAR_PATH" && \
    [ -n "$JAR_PATH" ] || { echo "ERROR: no jar found in zip"; exit 1; } && \
    cp "$JAR_PATH" /opt/brouter/brouter.jar && \
    rm -rf /tmp/brouter.zip /tmp/brouter-dist /tmp/release.json

# Download routing profiles from BRouter GitHub repo
RUN for p in fastbike fastbike-lowtraffic trekking safety shortest; do \
      curl -fL -o /brouter-data/profiles2/${p}.brf \
        "https://raw.githubusercontent.com/abrensch/brouter/master/misc/profiles2/${p}.brf" \
      && echo "OK: ${p}.brf" || echo "SKIP: ${p}.brf not found"; \
    done

# OCP: allow arbitrary UID (group write permissions)
RUN chgrp -R 0 /brouter-data /opt/brouter && chmod -R g=u /brouter-data /opt/brouter

USER 1001

EXPOSE 17777

CMD ["java", "-Xmx512m", "-Xms128m", \
     "-cp", "/opt/brouter/brouter.jar", \
     "btools.server.RouteServer", \
     "/brouter-data/segments4", \
     "/brouter-data/profiles2", \
     "/brouter-data/profiles2", \
     "17777", "1"]
