FROM registry.access.redhat.com/ubi8/openjdk-17-runtime:latest

USER root

RUN mkdir -p /brouter-data/segments4 /brouter-data/profiles2 /opt/brouter

# Download BRouter JAR from GitHub latest release
RUN curl -fL -o /opt/brouter/brouter.jar \
      https://github.com/abrensch/brouter/releases/latest/download/brouter.jar

# Download routing profiles from GitHub
RUN for p in fastbike fastbike-lowtraffic trekking safety shortest; do \
      curl -fL -o /brouter-data/profiles2/${p}.brf \
        https://raw.githubusercontent.com/abrensch/brouter/master/misc/profiles2/${p}.brf \
      && echo "OK: ${p}.brf" || echo "SKIP: ${p}.brf not found"; \
    done

# OCP: allow arbitrary UID (same pattern as backend)
RUN chgrp -R 0 /brouter-data /opt/brouter && chmod -R g=u /brouter-data /opt/brouter

USER 1001

EXPOSE 17777

# RouteServer args: <segmentsdir> <profilesdir> <customprofilesdir> <port> <maxthreads>
CMD ["java", "-Xmx512m", "-Xms128m", \
     "-cp", "/opt/brouter/brouter.jar", \
     "btools.server.RouteServer", \
     "/brouter-data/segments4", \
     "/brouter-data/profiles2", \
     "/brouter-data/profiles2", \
     "17777", "1"]
