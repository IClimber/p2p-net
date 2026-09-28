# p2p-net

Мережевий шар і сервер для браузерних P2P-ігор з кімнатами (використовується в [Firefighters](https://github.com/IClimber/firefighters)).

- **`v1/net.js`** — клієнт: WebRTC mesh між гравцями кімнати, ретрансляція для неповного mesh, вибір хоста, спільний годинник, живість, вихід, статистика з'єднань, двійковий формат повідомлень. Без залежностей і збірки.
- **`server/signal.mjs`** — сервер сигналізації (Node + `ws`): лише знайомить гравців кімнати, пересилає опис WebRTC-з'єднань і видає тимчасові облікові дані TURN. Сама гра через сервер не йде.
- **`deploy/`** — розгортання на Ubuntu 24.04 одним скриптом: сервер сигналізації, TURN (coturn), nginx з TLS на 443 (WebSocket і TURN/TLS на одному порту), сертифікат Let's Encrypt, systemd, фаєрвол.

## Підключення в гру

```js
import { createNet } from 'https://iclimber.github.io/p2p-net/v1/net.js';

const net = createNet({
  url: 'wss://144-172-110-72.sslip.io/ws',
  game: 'snake',                        // кімнати різних ігор не перетинаються
  room: location.hash.slice(1),
  messages: {
    pos:   { schema: { x: 'u16', y: 'u16' }, broadcast: true, unreliable: true },
    state: { schema: { r: 'f64', cells: ['u8'] }, broadcast: true },
    act:   { schema: { i: 'u8' } },     // адресне: net.send('act', {...}, net.hostId())
  },
  hasGame: () => …,                     // чи є в нас гра (такий гравець має перевагу на роль хоста)
  onMessage(kind, data, from) {},       // дані вже декодовані й перевірені за схемою
  onPeerOpen(id) {},                    // пряме з'єднання відкрилось — надіслати новачкові свій стан
  onPeerGone(id) {},                    // гравець вийшов або давно замовк
  onWelcome(others, again) {},          // сервер прийняв у кімнату; others — скільки там інших
  onVisibility(hidden) {},              // вкладка сховалась/повернулась
  onWarn(code) {},                      // 'link' | 'full' | 'outdated' | 'version'
  onChange() {},                        // оновити HUD
});
net.start();
```

API: `net.send(kind, data, to?)`, `net.id`, `net.hostId()`, `net.isHost()`, `net.announce()`, `net.restamp()`, `net.sharedNow()`, `net.isLive(id)`, `net.isAway(id)`, `net.liveCount()`, `net.linkCount()`, `net.peers()`, `net.status()`. Опис — на початку [`v1/net.js`](v1/net.js).

Типи полів схеми: `u8 u16 u32 i8 i16 i32 f32 f64 bool str bytes`, `[тип]` — масив, `{ поле: тип }` — об'єкт.
`broadcast` — усім (і ретранслюється тим, хто без прямого з'єднання з автором); `unreliable` — ненадійний невпорядкований канал з номером (для частого стану на кшталт позицій).

Гра сама відповідає за: кімнату з URL і посилання-запрошення, логіку входу (порожня кімната — старт одразу, інакше чекати стан від хоста), авторитетний стан у хоста, HUD. Приклад — `index.html` у Firefighters.

Сервер перевіряє Origin: сторінки з `https://iclimber.github.io/*` пускає; гру на іншому домені треба додати в `--origins` (див. нижче).

## Сервер

```bash
git clone https://github.com/IClimber/p2p-net.git && cd p2p-net
deploy/install.sh --ip 1.2.3.4 --origins https://user.github.io   # від root, Ubuntu 24.04
deploy/check.sh                                                    # служби, welcome з TURN, TURN UDP і TLS
```

- Параметри зберігаються в `/etc/p2p-net/config.env`; далі досить `git pull && deploy/install.sh`. `deploy/install.sh --check` — лише показати, що зміниться.
- `--host` — домен для сертифіката (за замовчуванням `1-2-3-4.sslip.io`, sslip.io резолвить його в IP). `--private-ip` — якщо публічна IP за NAT хмари. `--origins` — сайти з іграми через кому.
- Скрипт можна запускати повторно: секрет TURN і сертифікат не перегенеровуються, файли переписуються лише при змінах (старі — у `/var/backups/p2p-net/<час>/`), перезапускаються лише змінені служби; некоректний конфіг nginx — відкат.
- Порт 443 ділять WebSocket і TURN/TLS (nginx stream за ALPN), тому інших сайтів на 443 на цьому сервері бути не може — скрипт це перевіряє.
- Відкриті порти: 22, 80, 443/tcp, 3478/udp, 49152–65535/udp.

| Що | Де |
|---|---|
| сервер сигналізації | `/opt/p2p-net/signal.mjs`, служба `p2p-signal`, `127.0.0.1:8090`, `wss://<host>/ws` |
| TURN | coturn, `/etc/turnserver.conf`, drop-in `coturn.service.d/p2p-net.conf` |
| секрет TURN | `/etc/p2p-net/turn-secret` (root, 600), службі — через systemd `LoadCredential` |
| nginx | `sites-available/p2p-net` (80 — ACME, 4430 — HTTPS), `stream.d/p2p-net.conf` (443) |
| сертифікат | Let's Encrypt (webroot `/var/lib/p2p-net/acme`), після продовження — `reload nginx` |

## Версії

`v1/` — поточна версія клієнта, протокол із сервером `PROTOCOL = 2`. Сумісні виправлення йдуть у `v1/net.js` і одразу діють в усіх іграх. Несумісна зміна — нова папка `v2/`, а сервер приймає обидві версії (`PROTOCOLS` у `server/signal.mjs`), поки ігри не перейдуть.

Гравці з різними схемами повідомлень (напр., стара сторінка в кеші) одне одного ігнорують і бачать попередження.

## Тести

```bash
npm test        # або node --test test/
```
