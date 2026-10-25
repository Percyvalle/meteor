#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 VPS to run the relay.
#
# Installs Docker, closes every inbound port except SSH, and turns on unattended
# security updates. Nothing else is needed: the relay has no dependencies, and
# ingress comes through the Cloudflare tunnel rather than an open port.
#
#   curl -fsSL -o setup-vps.sh <this file> && sudo bash setup-vps.sh
#
# Safe to re-run.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите через sudo." >&2
  exit 1
fi

OPEN_WEB=0
for arg in "$@"; do
  case "$arg" in
    --open-web) OPEN_WEB=1 ;;   # прямой HTTPS через Caddy вместо туннеля
    *) echo "неизвестный аргумент: $arg" >&2; exit 1 ;;
  esac
done

TARGET_USER="${SUDO_USER:-root}"
SSH_PORT="$(grep -oP '^\s*Port\s+\K[0-9]+' /etc/ssh/sshd_config 2>/dev/null | head -1 || true)"
SSH_PORT="${SSH_PORT:-22}"

echo "==> Обновление пакетов"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

echo "==> Базовые утилиты"
apt-get install -y -qq ca-certificates curl gnupg git ufw fail2ban unattended-upgrades

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "    уже установлен, пропускаю"
fi
systemctl enable --now docker

if [ "$TARGET_USER" != "root" ]; then
  usermod -aG docker "$TARGET_USER"
  echo "    пользователь $TARGET_USER добавлен в группу docker (нужен повторный вход)"
fi

echo "==> Файрвол"
# With the tunnel, only SSH is reachable: the relay is published through the
# tunnel's outbound connection and needs no inbound rule at all.
# With direct HTTPS (Caddy) 80 and 443 must be open — pass --open-web.
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow "${SSH_PORT}/tcp" comment 'SSH' >/dev/null
if [ "${OPEN_WEB:-0}" = "1" ]; then
  ufw allow 80/tcp comment 'HTTP (ACME)' >/dev/null
  ufw allow 443/tcp comment 'HTTPS' >/dev/null
  ufw allow 443/udp comment 'HTTP/3' >/dev/null
  echo "    80/443 открыты для прямого HTTPS"
fi
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/    /'

echo "==> Автообновления безопасности"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

echo "==> fail2ban"
systemctl enable --now fail2ban >/dev/null 2>&1 || true

echo
echo "Готово."
docker --version | sed 's/^/    /'
docker compose version | sed 's/^/    /'
echo
echo "Дальше:"
echo "  1. Залить проект:   git clone <репозиторий> meteor   (или scp с локальной машины)"
echo "  2. cd meteor/deploy && cp .env.example .env && nano .env"
if [ "$OPEN_WEB" = "1" ]; then
  echo "  3. docker compose -f docker-compose.direct.yml up -d"
else
  echo "  3. docker compose up -d"
fi
echo "  4. docker compose logs -f relay"
