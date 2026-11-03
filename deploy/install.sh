#!/usr/bin/env bash
# Установка и обновление информационной панели на чистом сервере Ubuntu 22.04 / 24.04.
#
#   sudo bash deploy/install.sh табло.лицей-интернат24.рф
#
# Запуск повторно (с той же папкой проекта) обновляет программу, данные не трогает.
# Что делает: ставит Node.js 22 и Caddy (HTTPS), создаёт пользователя board, кладёт программу в /opt/school-board,
# данные — в /var/lib/school-board, включает автозапуск и еженедельную резервную копию.
set -euo pipefail

DOMAIN_ARG="${1:-}"
SKIP_FIREWALL=0
for a in "$@"; do [ "$a" = "--no-firewall" ] && SKIP_FIREWALL=1; done
[ "$DOMAIN_ARG" = "--no-firewall" ] && DOMAIN_ARG=""

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запустите от имени root:  sudo bash deploy/install.sh ваш.домен.рф"
command -v apt-get >/dev/null || die "скрипт рассчитан на Ubuntu/Debian (нужен apt-get)"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC/server.js" ] || die "не найдена папка проекта рядом со скриптом ($SRC)"
APP=/opt/school-board
DATA=/var/lib/school-board
BACKUPS=/var/backups/school-board
ENVF=/etc/school-board.env
DOMAIN_FILE=/etc/school-board.domain

# ---- домен ----
if [ -z "$DOMAIN_ARG" ] && [ -f "$DOMAIN_FILE" ]; then DOMAIN_ARG="$(cat "$DOMAIN_FILE")"; fi
[ -n "$DOMAIN_ARG" ] || die "укажите домен:  sudo bash deploy/install.sh табло.лицей-интернат24.рф"
apt-get update -y >/dev/null
apt-get install -y curl ca-certificates gnupg tar python3 >/dev/null
# кириллические домены Caddy и сертификаты используют в виде punycode (xn--...)
DOMAIN="$(python3 -c 'import sys; print(sys.argv[1].strip().lower().encode("idna").decode())' "$DOMAIN_ARG")" \
  || die "не удалось разобрать домен «$DOMAIN_ARG»"
echo "Домен: $DOMAIN_ARG  ($DOMAIN)"
echo "$DOMAIN_ARG" > "$DOMAIN_FILE"

# ---- проверка DNS: без неё сертификат HTTPS не выпустится ----
MYIP="$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
DNSIP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [ -n "$MYIP" ] && [ "$MYIP" != "$DNSIP" ]; then
  printf '\n\033[1;33mВнимание: домен %s сейчас указывает на «%s», а этот сервер — %s.\033[0m\n' "$DOMAIN_ARG" "${DNSIP:-ничего}" "$MYIP"
  echo "Создайте у регистратора запись A для этого имени на $MYIP. Установка продолжится, но HTTPS заработает только после этого."
fi

# ---- Node.js >= 22.5 (нужен встроенный SQLite) ----
need_node=1
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  say "Устанавливаю Node.js 22"
  if [ -n "${NODE_TARBALL:-}" ]; then
    tar -xJf "$NODE_TARBALL" -C /usr/local --strip-components=1
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - || die "не удалось подключить репозиторий Node.js. Скачайте с nodejs.org архив node-v22.*-linux-x64.tar.xz, положите на сервер и запустите:  NODE_TARBALL=/путь/к/архиву sudo -E bash deploy/install.sh $DOMAIN_ARG"
    apt-get install -y nodejs >/dev/null
  fi
fi
[ "$(command -v node)" = "/usr/bin/node" ] || ln -sf "$(command -v node)" /usr/bin/node
say "Node.js $(node -v)"

# ---- Caddy ----
if ! command -v caddy >/dev/null; then
  say "Устанавливаю Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list || die "не удалось подключить репозиторий Caddy"
  apt-get update -y >/dev/null
  apt-get install -y caddy >/dev/null
fi

# ---- пользователь и папки ----
id board >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin board
mkdir -p "$APP" "$DATA" "$BACKUPS"
chown -R board:board "$DATA" "$BACKUPS"
chmod 750 "$DATA" "$BACKUPS"

# ---- программа ----
say "Копирую программу в $APP"
BRAND_KEEP="$(mktemp -d)"; cp -a "$APP/public/brand/." "$BRAND_KEEP/" 2>/dev/null || true   # логотип переживает обновление
rm -rf "$APP/public" "$APP/lib" "$APP/scripts" "$APP/deploy" "$APP/test"
tar -C "$SRC" --exclude=./data --exclude=./node_modules --exclude=./backups --exclude=./.git -cf - . | tar -C "$APP" -xf -
mkdir -p "$APP/public/brand"
cp -an "$BRAND_KEEP/." "$APP/public/brand/" 2>/dev/null || true   # файлы из нового релиза важнее старых
rm -rf "$BRAND_KEEP"
chown -R root:root "$APP"
say "Устанавливаю зависимости (сжатие картинок — необязательно)"
( cd "$APP" && HOME=/tmp npm install --omit=dev --no-audit --no-fund --cache /tmp/npm-cache >/dev/null 2>&1 ) \
  || echo "Не удалось поставить дополнительные пакеты: картинки не будут сжиматься до 500 КБ, остальное работает."
chown -R root:root "$APP/node_modules" 2>/dev/null || true

# ---- настройки ----
if [ ! -f "$ENVF" ]; then
  cp "$APP/deploy/school-board.env.example" "$ENVF"
  echo "BACKUP_DIR=$BACKUPS" >> "$ENVF"
  chmod 600 "$ENVF"
  echo "Создан файл настроек $ENVF"
else
  grep -q '^BACKUP_DIR=' "$ENVF" || echo "BACKUP_DIR=$BACKUPS" >> "$ENVF"
fi

# ---- сервис ----
install -m 644 "$APP/deploy/school-board.service" /etc/systemd/system/school-board.service
install -m 644 "$APP/deploy/school-board-backup.service" /etc/systemd/system/school-board-backup.service
install -m 644 "$APP/deploy/school-board-backup.timer" /etc/systemd/system/school-board-backup.timer
systemctl daemon-reload
systemctl enable school-board.service school-board-backup.timer >/dev/null
systemctl restart school-board.service
systemctl start school-board-backup.timer

# ---- Caddy: HTTPS и проксирование ----
sed "s|__DOMAIN__|$DOMAIN|g" "$APP/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "конфигурация Caddy не прошла проверку (caddy validate --config /etc/caddy/Caddyfile)"
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy

# ---- межсетевой экран ----
if [ "$SKIP_FIREWALL" -eq 0 ] && command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

# ---- проверка ----
say "Проверяю, что сервис отвечает"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  journalctl -u school-board -n 30 --no-pager || true
  die "сервис не запустился, см. журнал выше"
fi

cat <<EOF

================================================================
 Готово.
   Экран для ТВ:     https://$DOMAIN_ARG/tv
   Страница учеников: https://$DOMAIN_ARG/
   Админка:          https://$DOMAIN_ARG/admin
EOF
# пароль первого директора лежит в файле (0600), а не в журнале службы; файл удалится после смены пароля
PWF="$DATA/first-admin-password.txt"
if [ -f "$PWF" ]; then
  echo "   Первый вход:      логин: director   $(grep -o 'пароль: .*' "$PWF" | head -1)"
  echo "   (пароль нужно будет сменить при первом входе; файл $PWF удалится сам)"
else
  echo "   Вход в админку: используйте существующий логин и пароль."
fi
echo " Журнал работы:  journalctl -u school-board -f"
echo "================================================================"
