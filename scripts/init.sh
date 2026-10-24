#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
if [ -f .env ]; then echo '.env already exists; preserved.'; exit 0; fi
umask 077
{
  printf 'APP_KEY=base64:%s\n' "$(openssl rand -base64 32)"
  printf 'DB_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'WEBHOOK_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'APP_PORT=8180\nWEB_PORT=5180\n'
} > .env
echo 'Generated .env with random local secrets. It is ignored by Git.'
