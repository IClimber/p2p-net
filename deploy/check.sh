#!/usr/bin/env bash
# p2p-net: перевірка розгорнутого сервера. Запускати від root після deploy/install.sh.
#   deploy/check.sh            служби, сервер сигналізації (welcome з TURN), TURN через UDP і TLS на 443
#   deploy/check.sh --renew    те саме + пробне продовження сертифіката
set -uo pipefail

CONF=/etc/p2p-net/config.env
[ -f "$CONF" ] || { echo "немає $CONF — спершу deploy/install.sh"; exit 1; }
. "$CONF"
FAIL=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }

echo "Служби"
for s in coturn nginx p2p-signal certbot.timer; do
  if systemctl is-active --quiet "$s" && systemctl is-enabled --quiet "$s"; then ok "$s активна, в автозапуску"; else bad "$s: $(systemctl is-active "$s") / $(systemctl is-enabled "$s" 2>&1)"; fi
done

echo "Сервер сигналізації (wss://$HOST/ws)"
ORIGIN=${ORIGINS%%,*}
OUT=$(NODE_PATH=/usr/share/nodejs timeout 10 node -e '
const W = require("ws");
const str = (x) => { const b = Buffer.from(x); return Buffer.concat([Buffer.from([b.length]), b]); };
// ALPN http/1.1 обовʼязковий: без ALPN stream-проксі відправить зʼєднання в TURN/TLS
const s = new W(process.argv[1], { origin: process.argv[2], ALPNProtocols: ["http/1.1"] });
s.on("open", () => s.send(Buffer.concat([Buffer.from([1, 2]), str("selfcheck"), str("check"), str("selfcheck01")])));
s.on("message", (m, bin) => { console.log(bin && m[0] === 1 ? (/turns?:/.test(m.toString("latin1")) ? "welcome+turn" : "welcome") : "інше"); process.exit(0); });
s.on("unexpected-response", (q, r) => { console.log("HTTP " + r.statusCode); process.exit(0); });
s.on("error", (e) => { console.log(e.message); process.exit(0); });
' "wss://$HOST/ws" "$ORIGIN" 2>&1)
case $OUT in
  welcome+turn) ok "welcome з обліковими даними TURN (Origin $ORIGIN)" ;;
  welcome) bad "welcome без TURN: сервер не прочитав секрет" ;;
  *) bad "немає welcome: ${OUT:-таймаут}" ;;
esac

echo "TURN"
if command -v turnutils_uclient >/dev/null && [ -r /etc/p2p-net/turn-secret ]; then
  U="$(( $(date +%s) + 600 )):check"
  P=$(printf '%s' "$U" | openssl dgst -sha1 -hmac "$(cat /etc/p2p-net/turn-secret)" -binary | base64)
  r=$(timeout 20 turnutils_uclient -y -n 1 -m 1 -u "$U" -w "$P" "$PUBLIC_IP" 2>&1 | grep -o 'lost packets [0-9]*' | tail -1)
  [ "$r" = "lost packets 0" ] && ok "UDP 3478: relay працює" || bad "UDP 3478: ${r:-немає відповіді}"
  r=$(timeout 20 turnutils_uclient -y -S -t -p 443 -n 1 -m 1 -u "$U" -w "$P" "$PUBLIC_IP" 2>&1 | grep -o 'lost packets [0-9]*' | tail -1)
  [ "$r" = "lost packets 0" ] && ok "TLS 443: relay працює" || bad "TLS 443: ${r:-немає відповіді}"
else
  bad "немає turnutils_uclient або секрету"
fi

if [ "${1:-}" = --renew ]; then
  echo "Сертифікат"
  certbot renew --dry-run --cert-name "$HOST" >/dev/null 2>&1 && ok "пробне продовження успішне" || bad "пробне продовження не вдалося (certbot renew --dry-run)"
fi

[ $FAIL = 0 ] && echo "Усе працює" || { echo "Є проблеми"; exit 1; }
