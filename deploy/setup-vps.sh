#!/usr/bin/env bash
# ============================================================
# Первичная настройка Ubuntu 24.04 VPS под Node-сайты.
# Запускать ОДИН раз от root:  sudo bash setup-vps.sh
# Идемпотентный — можно перезапускать.
# ============================================================
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

echo "==> Обновление системы"
apt-get update -y
apt-get -y upgrade || true

echo "==> Swap 2 ГБ (страховка для 1 ГБ RAM)"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

echo "==> Node.js 20 + инструменты (сборка нативного sqlite3)"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential python3 git nginx certbot python3-certbot-nginx
npm install -g pm2

echo "==> Файрвол (SSH + HTTP + HTTPS)"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

mkdir -p /var/www

echo
echo "✅ Система готова:"
node -v && npm -v && nginx -v && pm2 -v
