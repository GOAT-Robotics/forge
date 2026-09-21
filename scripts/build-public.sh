#!/bin/sh
# Build this public-image project without invoking a broken global registry helper.
# The user's Docker credentials/configuration are never changed.
set -eu
cd "$(dirname "$0")/.."
forge_endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
forge_config=$(mktemp -d)
trap 'rm -rf "$forge_config"' EXIT HUP INT TERM
python3 - "$forge_config" "$HOME/.docker/cli-plugins" <<'PY'
import json,sys
from pathlib import Path
(Path(sys.argv[1])/'config.json').write_text(json.dumps({'auths':{},'credsStore':'','cliPluginsExtraDirs':[sys.argv[2]]}))
PY
DOCKER_CONFIG="$forge_config" DOCKER_HOST="$forge_endpoint" docker compose build
