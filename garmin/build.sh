#!/usr/bin/env bash
# Build the Squadrats data field for Edge 1040/1050.
#   GARMIN_KEY=<key from /api/profile/garmin-key> ./build.sh [device] [--export]
# Writes resources-local/properties.xml (server URL + key; not committed).
set -euo pipefail
cd "$(dirname "$0")"
DEV=${1:-edge1040}
SDK=$(~/opt/garmin/cli/connect-iq-sdk-manager sdk current-path --bin)
export PATH=$HOME/opt/garmin/jdk-17.0.20.1+1-jre/bin:$SDK:$PATH
URL=${SQUADRATS_URL:-https://claude-base.tailb95301.ts.net}
mkdir -p resources-local bin
cat > resources-local/properties.xml <<XML
<properties>
    <property id="serverUrl" type="string">$URL</property>
    <property id="apiKey" type="string">${GARMIN_KEY:-}</property>
</properties>
XML
if [ "${2:-}" = "--export" ]; then
  monkeyc -e -f monkey.jungle -o bin/Squadrats.iq -y ~/opt/garmin/keys/developer_key.der -r
else
  monkeyc -d "$DEV" -f monkey.jungle -o "bin/Squadrats-$DEV.prg" -y ~/opt/garmin/keys/developer_key.der -r
fi
