#!/usr/bin/env bash
# p2p-net: розгортання і оновлення сервера (сигналізація + TURN + nginx) на Ubuntu 24.04. Запускати від root.
#
#   Перший запуск:        deploy/install.sh --ip 1.2.3.4 --origins https://user.github.io
#   Оновлення:            git pull && deploy/install.sh
#   Лише показати зміни:  deploy/install.sh --check
#
# Параметри (зберігаються в /etc/p2p-net/config.env, далі їх можна не вказувати):
#   --ip IP              публічна IPv4
#   --private-ip IP      приватна IP інтерфейсу, якщо публічна — за NAT хмари (інакше не вказувати)
#   --host ІМ'Я          домен для сертифіката (за замовчуванням <ip з дефісами>.sslip.io)
#   --origins СПИСОК     сайти з іграми через кому (перевірка Origin на сервері сигналізації)
#   --port ПОРТ          локальний порт сервера сигналізації (8090)
#
# Скрипт можна запускати повторно: секрет TURN і сертифікат не перегенеровуються, файли переписуються
# лише якщо змінились (старі копії — у /var/backups/p2p-net/<час>/), служби перезапускаються лише ті, що змінились.
# Якщо на сервері є ручне встановлення Firefighters (ff-signal, /etc/ff-turn), воно переноситься сюди
# з тим самим секретом TURN і сертифікатом.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
TPL=$REPO/deploy/templates
CONF=/etc/p2p-net/config.env
SECRET=/etc/p2p-net/turn-secret
ACME=/var/lib/p2p-net/acme
BACKUP=/var/backups/p2p-net/$(date +%Y%m%d-%H%M%S)
PACKAGES=(coturn nginx libnginx-mod-stream certbot ufw nodejs node-ws openssl)

CHECK=0
declare -A ARG=()
while [ $# -gt 0 ]; do
  case $1 in
    --ip) ARG[PUBLIC_IP]=$2; shift 2 ;;
    --private-ip) ARG[PRIVATE_IP]=$2; shift 2 ;;
    --host) ARG[HOST]=$2; shift 2 ;;
    --origins) ARG[ORIGINS]=$2; shift 2 ;;
    --port) ARG[SIGNAL_PORT]=$2; shift 2 ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Невідомий параметр: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'ПОМИЛКА: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "потрібен root"

# ---------- Налаштування ----------
PUBLIC_IP='' PRIVATE_IP='' HOST='' ORIGINS='' SIGNAL_PORT=''
if [ -f "$CONF" ]; then . "$CONF"; fi
for k in "${!ARG[@]}"; do printf -v "$k" '%s' "${ARG[$k]}"; done
[ -n "$PUBLIC_IP" ] || die "вкажіть --ip (публічна IPv4 сервера)"
[ -n "$ORIGINS" ] || die "вкажіть --origins (сайти з іграми, напр. https://user.github.io)"
HOST=${HOST:-${PUBLIC_IP//./-}.sslip.io}
SIGNAL_PORT=${SIGNAL_PORT:-8090}
IP_RE='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
[[ $PUBLIC_IP =~ $IP_RE ]] || die "некоректна IP: $PUBLIC_IP"
[ -z "$PRIVATE_IP" ] || [[ $PRIVATE_IP =~ $IP_RE ]] || die "некоректна приватна IP: $PRIVATE_IP"
[[ $HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "некоректне ім'я: $HOST"
[[ $ORIGINS =~ ^(https?://[A-Za-z0-9.:-]+)(,https?://[A-Za-z0-9.:-]+)*$ ]] || die "некоректний --origins: $ORIGINS (без шляху і пробілів, через кому)"
[[ $SIGNAL_PORT =~ ^[0-9]+$ ]] || die "некоректний порт: $SIGNAL_PORT"
BIND_IP=${PRIVATE_IP:-$PUBLIC_IP}                        # на цій IP слухає coturn
EXTERNAL_IP=$PUBLIC_IP${PRIVATE_IP:+/$PRIVATE_IP}        # coturn за NAT: ПУБЛІЧНА/ПРИВАТНА
CERT=/etc/letsencrypt/live/$HOST/fullchain.pem

LEGACY=0                                                 # ручне встановлення Firefighters (до p2p-net)
if [ -e /etc/ff-turn ] || [ -e /etc/systemd/system/ff-signal.service ] || [ -e /etc/nginx/sites-available/ff-turn ]; then LEGACY=1; fi

# Секрет TURN: наявний, або перенесений зі старого встановлення, або новий
if [ -s "$SECRET" ]; then TURN_SECRET=$(cat "$SECRET")
elif [ -s /etc/ff-turn/secret ]; then TURN_SECRET=$(cat /etc/ff-turn/secret)
else TURN_SECRET=$(openssl rand -hex 32)
fi

render() {
  sed -e "s|@@PUBLIC_IP@@|$PUBLIC_IP|g; s|@@BIND_IP@@|$BIND_IP|g; s|@@EXTERNAL_IP@@|$EXTERNAL_IP|g" \
      -e "s|@@HOST@@|$HOST|g; s|@@ORIGINS@@|$ORIGINS|g; s|@@SIGNAL_PORT@@|$SIGNAL_PORT|g; s|@@TURN_SECRET@@|$TURN_SECRET|g" "$@"
}
mask() { sed -E 's/^([-+ ]?static-auth-secret=).*/\1***/'; }

# ---------- Встановлення файлів ----------
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
CHANGED=() NEW=()
changed() { local x; for x in "${CHANGED[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
# put ФАЙЛ-З-ВМІСТОМ ПРИЗНАЧЕННЯ РЕЖИМ ВЛАСНИК:ГРУПА [СТАРИЙ-ВІДПОВІДНИК-ДЛЯ---check]
put() {
  local src=$1 dst=$2 mode=$3 own=$4 old=${5:-}
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then return 0; fi
  CHANGED+=("$dst")
  if [ $CHECK = 1 ]; then
    local base=$dst
    [ -f "$dst" ] || { [ -n "$old" ] && [ -f "$old" ] && base=$old; } || base=/dev/null
    say "~ $dst${old:+ (порівняно з $base)}"
    if [ "$dst" = "$SECRET" ]; then echo "(вміст секрету не показується)"
    else diff -u --label "$base" --label "$dst" "$base" "$src" | mask || true; fi
    return 0
  fi
  if [ -f "$dst" ]; then mkdir -p "$BACKUP$(dirname "$dst")"; cp -a "$dst" "$BACKUP$dst"; else NEW+=("$dst"); fi
  install -D -m "$mode" -o "${own%:*}" -g "${own#*:}" "$src" "$dst"
  echo "записано: $dst"
}
# Прибрати файл або каталог (з копією в $BACKUP)
drop() {
  local p
  for p in "$@"; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    if [ $CHECK = 1 ]; then say "- $p (буде прибрано)"; continue; fi
    mkdir -p "$BACKUP$(dirname "$p")"
    mv "$p" "$BACKUP$p"
    echo "прибрано: $p (копія в $BACKUP)"
  done
}
# Відкотити файли: прибрати створені, повернути змінені й прибрані з $BACKUP (служби ще не чіпали)
rollback() {
  local f
  for f in "${NEW[@]}"; do rm -f "$f"; done
  [ ! -d "$BACKUP" ] || cp -a "$BACKUP"/. /
  echo "файли відкочено"
}
# Значущий вміст конфігу (без коментарів і порожніх рядків): чи треба перезапускати службу
effective() { [ -f "$1" ] && grep -vE '^\s*(#|$)' "$1" || true; }

# ---------- 1. Пакети ----------
if [ $CHECK = 0 ]; then
  missing=()
  for p in "${PACKAGES[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  if [ ${#missing[@]} -gt 0 ]; then
    say "Встановлення пакетів: ${missing[*]}"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  fi
fi

# 443 займає stream-проксі: інші сайти nginx мають слухати 127.0.0.1:4430 з proxy_protocol, а не 443
others=$(grep -lsE '^\s*listen\s+(\[::\]:)?443\b' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null \
  | grep -vE '/(p2p-net|ff-turn)(\.conf)?$' || true)
[ -z "$others" ] || die "порт 443 уже слухають інші сайти nginx: $others"

# ---------- 2. Налаштування і секрет ----------
printf '# p2p-net: параметри встановлення (deploy/install.sh)\nPUBLIC_IP=%s\nPRIVATE_IP=%s\nHOST=%s\nORIGINS=%s\nSIGNAL_PORT=%s\n' \
  "$PUBLIC_IP" "$PRIVATE_IP" "$HOST" "$ORIGINS" "$SIGNAL_PORT" > "$STAGE/config.env"
put "$STAGE/config.env" "$CONF" 644 root:root
printf '%s\n' "$TURN_SECRET" > "$STAGE/secret"
put "$STAGE/secret" "$SECRET" 600 root:root /etc/ff-turn/secret

# ---------- 3. Сервер сигналізації ----------
put "$REPO/server/signal.mjs" /opt/p2p-net/signal.mjs 644 root:root /opt/ff-signal/signal.mjs
render "$TPL/p2p-signal.service" > "$STAGE/p2p-signal.service"
put "$STAGE/p2p-signal.service" /etc/systemd/system/p2p-signal.service 644 root:root /etc/systemd/system/ff-signal.service

# ---------- 4. coturn ----------
TURN_BEFORE=$(effective /etc/turnserver.conf)
render "$TPL/turnserver.conf" > "$STAGE/turnserver.conf"
put "$STAGE/turnserver.conf" /etc/turnserver.conf 640 root:turnserver
put "$TPL/coturn-override.conf" /etc/systemd/system/coturn.service.d/p2p-net.conf 644 root:root /etc/systemd/system/coturn.service.d/override.conf
TURN_RESTART=0
[ "$TURN_BEFORE" = "$(effective "$STAGE/turnserver.conf")" ] || TURN_RESTART=1

# ---------- 5. nginx ----------
NGINX_CONF=/etc/nginx/nginx.conf
if [ -f "$NGINX_CONF" ]; then
  cp "$NGINX_CONF" "$STAGE/nginx.conf"
  grep -q '^worker_rlimit_nofile' "$STAGE/nginx.conf" || sed -i 's/^worker_processes auto;$/&\nworker_rlimit_nofile 16384;/' "$STAGE/nginx.conf"
  sed -i 's/worker_connections 768;/worker_connections 4096;/' "$STAGE/nginx.conf"
  grep -q 'include /etc/nginx/stream.d/\*.conf;' "$STAGE/nginx.conf" \
    || printf '\n# TURN поверх TLS на 443 (p2p-net)\ninclude /etc/nginx/stream.d/*.conf;\n' >> "$STAGE/nginx.conf"
  put "$STAGE/nginx.conf" "$NGINX_CONF" 644 root:root
fi
render "$TPL/certbot-deploy-hook.sh" > "$STAGE/hook.sh"
put "$STAGE/hook.sh" /etc/letsencrypt/renewal-hooks/deploy/p2p-net-reload-nginx.sh 755 root:root
SITE=/etc/nginx/sites-available/p2p-net
STREAM=/etc/nginx/stream.d/p2p-net.conf

nginx_apply() {                                          # перевірити конфіг і перезавантажити nginx
  nginx -t 2>&1 | tail -2
  systemctl enable --now nginx >/dev/null 2>&1 || true
  systemctl reload nginx
}

# Сертифікату ще немає: спершу лише порт 80, отримати сертифікат (webroot), далі повний конфіг
if [ ! -f "$CERT" ]; then
  if [ $CHECK = 1 ]; then say "+ сертифікат для $HOST буде отримано (certbot --webroot)"
  else
    say "Отримання сертифіката для $HOST"
    mkdir -p "$ACME"
    render "$TPL/nginx-http.conf" > "$STAGE/site-http"
    install -D -m 644 "$STAGE/site-http" "$SITE"
    ln -sfn "$SITE" /etc/nginx/sites-enabled/p2p-net
    rm -f /etc/nginx/sites-enabled/default
    [ ! -e "$STREAM" ] || mv "$STREAM" "$STAGE/stream.off"   # stream посилається на сертифікат, якого ще немає
    nginx_apply
    certbot certonly --webroot -w "$ACME" -d "$HOST" --key-type ecdsa \
      --agree-tos --register-unsafely-without-email --non-interactive
    [ ! -e "$STAGE/stream.off" ] || mv "$STAGE/stream.off" "$STREAM"
  fi
fi
[ $CHECK = 1 ] || mkdir -p "$ACME"
{ render "$TPL/nginx-http.conf"; echo; render "$TPL/nginx-https.conf"; } > "$STAGE/site"
put "$STAGE/site" "$SITE" 644 root:root /etc/nginx/sites-available/ff-turn
render "$TPL/nginx-stream.conf" > "$STAGE/stream"
put "$STAGE/stream" "$STREAM" 644 root:root /etc/nginx/stream.d/ff-turn.conf
if [ "$(readlink /etc/nginx/sites-enabled/p2p-net 2>/dev/null)" != "$SITE" ]; then
  CHANGED+=(/etc/nginx/sites-enabled/p2p-net)
  if [ $CHECK = 1 ]; then say "+ /etc/nginx/sites-enabled/p2p-net -> $SITE"
  else ln -sfn "$SITE" /etc/nginx/sites-enabled/p2p-net; NEW+=(/etc/nginx/sites-enabled/p2p-net); fi
fi
drop /etc/nginx/sites-enabled/default

# ---------- 6. Старе встановлення Firefighters ----------
if [ $LEGACY = 1 ]; then
  say "Перенесення старого встановлення (ff-signal, ff-turn, turn.php)"
  drop /etc/nginx/sites-enabled/ff-turn /etc/nginx/sites-available/ff-turn /etc/nginx/stream.d/ff-turn.conf
fi

# ---------- 7. Застосування ----------
if [ $CHECK = 1 ]; then
  [ $LEGACY = 0 ] || say "- служби ff-signal і php8.3-fpm буде зупинено й вимкнено; /opt/ff-signal, /var/www/ff-turn, /etc/ff-turn, coturn override.conf — прибрано"
  [ ${#CHANGED[@]} -gt 0 ] || say "Змін немає"
  exit 0
fi

if changed "$NGINX_CONF" || changed "$SITE" || changed "$STREAM" || changed /etc/nginx/sites-enabled/p2p-net || [ $LEGACY = 1 ]; then
  if ! nginx -t >/dev/null 2>&1; then
    nginx -t || true
    rollback
    die "конфіг nginx некоректний, нічого не застосовано"
  fi
  nginx_apply
fi

systemctl daemon-reload
if [ $LEGACY = 1 ]; then
  systemctl disable --now ff-signal.service 2>/dev/null || true   # звільнити порт для p2p-signal
  drop /etc/systemd/system/ff-signal.service /opt/ff-signal /var/www/ff-turn /etc/ff-turn \
       /etc/systemd/system/coturn.service.d/override.conf
  systemctl disable --now php8.3-fpm 2>/dev/null || true           # потрібен був лише для turn.php
  systemctl daemon-reload
fi
if [ $TURN_RESTART = 1 ]; then systemctl restart coturn; echo "coturn перезапущено"; fi
systemctl enable coturn nginx certbot.timer >/dev/null 2>&1
systemctl enable p2p-signal >/dev/null 2>&1
if changed /opt/p2p-net/signal.mjs || changed /etc/systemd/system/p2p-signal.service || changed "$SECRET" \
   || ! systemctl is-active --quiet p2p-signal; then
  systemctl restart p2p-signal
  echo "p2p-signal перезапущено"
fi

# ---------- 8. Фаєрвол ----------
for p in $(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }'); do ufw allow "$p/tcp" >/dev/null; done
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 3478/udp >/dev/null
ufw allow 49152:65535/udp >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
systemctl disable --now avahi-daemon.service avahi-daemon.socket >/dev/null 2>&1 || true

say "Готово. Сервер сигналізації: wss://$HOST/ws"
[ ${#CHANGED[@]} -eq 0 ] || echo "Попередні версії змінених файлів: $BACKUP"
echo "Перевірка: $REPO/deploy/check.sh"
