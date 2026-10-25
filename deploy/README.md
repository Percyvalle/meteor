# Деплой релея

Здесь только релей. Локальный хост стримера в Docker не кладём: он отдаёт оверлей в OBS на той же машине, и требовать от стримера Docker Desktop — верный способ растерять пользователей.

## Подготовка VPS

Чистая Ubuntu 24.04:

```bash
sudo bash setup-vps.sh
```

Ставит Docker, закрывает файрволом всё кроме SSH, включает автообновления безопасности и fail2ban. Больше ничего не нужно: Node живёт в контейнере, TLS терминирует Cloudflare, базы нет. Скрипт можно запускать повторно.

## Быстрый старт

```bash
cd deploy
cp .env.example .env     # заполнить
docker compose up -d
```

Поднимется два контейнера: релей и туннель Cloudflare к нему. Наружу **не открыт ни один порт** — Cloudflare достаёт до релея через исходящее соединение туннеля, сертификатами заниматься не нужно.

```bash
docker compose logs -f relay     # что происходит
docker compose ps                # healthcheck
docker compose pull && docker compose up -d   # обновиться
```

## Что заполнить в `.env`

| Переменная | Откуда |
|---|---|
| `RELAY_PUBLIC_URL` | ваш постоянный домен, например `https://relay.example.com` |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | приложение на [kick.com/settings/developer](https://kick.com/settings/developer) — **одно на всех стримеров** |
| `CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel → Docker |

В приложении Kick прописывается один раз:

- **Webhook URL** — `https://relay.example.com/webhooks/kick`
- **Redirect URI** — `https://relay.example.com/auth/kick/callback`
- Разрешения: чтение пользователя и канала, запись в чат, подписка на события. Без `events:subscribe` Kick отвечает голым 401 на создание подписки.
- Нажмите «Создать бота для этого приложения», если бот должен писать в чат от своего имени.

В туннеле Cloudflare задайте Public Hostname: `relay.example.com` → `http://relay:8088` (имя сервиса из compose, не `localhost`).

## Данные

Привязки стримеров и их токены Kick лежат в именованном томе `relay-data`, файл `/data/relay-state.json` с правами `0600`. Пересоздание контейнера их не теряет, удаление тома — теряет, и тогда всем придётся заново нажать «Подключить Kick».

```bash
docker run --rm -v meteor_relay-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/relay-backup.tar.gz -C /data .
```

## Без Cloudflare

Если есть свой реверс-прокси с сертификатом: уберите сервис `cloudflared` и раскомментируйте `ports` у релея. Релей слушает обычный HTTP на `8088` и TLS не терминирует.

## Проверка

```bash
curl https://relay.example.com/status
```

Отдаёт JSON со списком агентов и числом подключённых. Та же страница в браузере — человекочитаемая таблица: канал, привязан ли Kick, онлайн ли хост.

## Если что-то не так

| Симптом | Причина |
|---|---|
| `set RELAY_PUBLIC_URL in .env` при старте | не заполнен `.env` |
| Туннель рвётся каждые ~40 с, `Error 1033` | сеть фильтрует трафик к edge-диапазону Cloudflare; compose уже использует `--protocol http2` вместо QUIC, но помогает не везде |
| `502` от Cloudflare | Public Hostname указывает не на `http://relay:8088` |
| В логах `event for unlinked broadcaster` | пришло событие канала, который ни к кому не привязан — стример не нажал «Подключить Kick» или отвязался |
| В логах `offline` | хост стримера не запущен; событие подтверждено, чтобы Kick не копил ретраи |
