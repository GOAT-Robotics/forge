#!/usr/bin/env bash
# Creates (or updates) the Microsoft Entra ID app registration for Forge with the Azure CLI and
# writes the client id / secret / issuer into .env.
#
#   az login                                     # once, as a tenant admin (or app developer)
#   scripts/entra-register.sh                    # localhost only (http://localhost:8100)
#   scripts/entra-register.sh --url https://forge.goat-robotics.com   # add the production redirect
#
# Sign-in is single-tenant (AzureADMyOrg); Forge additionally accepts only ALLOWED_EMAIL_DOMAINS
# (goat-robotics.com) members and rejects guest accounts.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="Forge – GOAT Robotics"
URLS=("http://localhost:8100" "http://localhost:5173")
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URLS+=("${2%/}"); shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

command -v az >/dev/null || { echo "Azure CLI (az) is required: https://aka.ms/azcli"; exit 1; }
az account show >/dev/null 2>&1 || az login >/dev/null

TENANT=$(az account show --query tenantId -o tsv)
REDIRECTS=()
for u in "${URLS[@]}"; do REDIRECTS+=("$u/api/auth/entra/callback"); done

APP_ID=$(az ad app list --display-name "$NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  echo "→ Creating app registration \"$NAME\""
  APP_ID=$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "${REDIRECTS[@]}" --query appId -o tsv)
  az ad sp create --id "$APP_ID" >/dev/null
else
  echo "→ Updating existing app registration ($APP_ID)"
  az ad app update --id "$APP_ID" --web-redirect-uris "${REDIRECTS[@]}"
fi
az ad app update --id "$APP_ID" --optional-claims '{"idToken":[{"name":"email","essential":false},{"name":"idp","essential":false}]}' >/dev/null
# Microsoft Graph User.Read (delegated) for openid/profile/email
az ad app permission add --id "$APP_ID" --api 00000003-0000-0000-c000-000000000000 --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope >/dev/null 2>&1 || true
az ad app permission admin-consent --id "$APP_ID" >/dev/null 2>&1 || echo "  (admin consent not granted — users will be asked to consent on first sign-in)"

echo "→ Creating client secret (2 years)"
SECRET=$(az ad app credential reset --id "$APP_ID" --display-name "forge-$(date +%Y%m%d)" --years 2 --append --query password -o tsv)

[ -f .env ] || cp .env.example .env
python3 - "$APP_ID" "$SECRET" "$TENANT" <<'PY'
import re, sys, secrets
app, secret, tenant = sys.argv[1:4]
s = open('.env').read()
def put(k, v):
    global s
    line = f'{k}={v}'
    s = re.sub(rf'^{k}=.*$', line, s, flags=re.M) if re.search(rf'^{k}=', s, re.M) else s + '\n' + line
put('AUTH_MICROSOFT_ENTRA_ID_ID', app)
put('AUTH_MICROSOFT_ENTRA_ID_SECRET', secret)
put('AUTH_MICROSOFT_ENTRA_ID_ISSUER', f'https://login.microsoftonline.com/{tenant}/v2.0/')
if not re.search(r'^FORGE_SECRET=\S+', s, re.M):
    put('FORGE_SECRET', secrets.token_hex(32))
open('.env', 'w').write(s)
PY

echo
echo "Entra app: $APP_ID (tenant $TENANT)"
echo "Redirect URIs:"; printf '  %s\n' "${REDIRECTS[@]}"
echo ".env updated. For production set PUBLIC_URL and COOKIE_SECURE=true."
