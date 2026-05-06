# BaizeAI Backend

Single-file Fastify backend with SQLite storage.

## Run locally

```bash
npm install
JWT_SECRET="$(openssl rand -base64 32)" PORT=3000 node server.js
```

Visit `http://localhost:3000/api/health` to confirm it's up.

## Environment variables

| Var | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Listen host (use `0.0.0.0` to expose; recommended to keep behind nginx) |
| `JWT_SECRET` | `CHANGE_ME_IN_PROD_PLEASE` | **Set a strong random string in production** |
| `COOKIE_SECURE` | `0` | Set to `1` after enabling HTTPS |
| `DB_PATH` | `./data/baize.db` | SQLite database file path |

## Database

SQLite is initialized on first boot. All tables, indexes and seed users are
created automatically. Default admin: `admin` / `1234567890` — **change this
in `SEED_ADMIN` of `server.js` before deploying to a public server.**

## Compliance RAG

Drop your own `.docx` knowledge documents anywhere, run:

```bash
SRC_DIR=/path/to/your/docx-folder node extract-compliance.js
```

This generates `./compliance/*.txt` + `manifest.json`. Move those into
`<DB_PATH dir>/compliance/` (e.g. `./data/compliance/`), restart the server,
and the "产品合规分析" agent will retrieve from them.

## API surface

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/auth/register` | public | username/password/role |
| `POST` | `/api/auth/login` | public | sets HttpOnly cookie |
| `POST` | `/api/auth/logout` | session | clears cookie |
| `GET`  | `/api/auth/me` | session | current user |
| `GET`  | `/api/api-status` | session | which APIs admin has configured |
| `POST` | `/api/chat` | session | one-shot chat (per agent) |
| `POST` | `/api/image` | session | image gen via configured API |
| `*`    | `/api/chats[/...]` | session | persistent multi-turn sessions |
| `*`    | `/api/schedule[/...]` | session (student) | calendar |
| `*`    | `/api/knowledge[/...]` | session (student) | knowledge base |
| `*`    | `/api/tickets[/...]` | session | enterprise post / student claim |
| `*`    | `/api/grades[/...]` | session | teacher grades students |
| `*`    | `/api/capability/layout` | session | shared capability map layout |
| `*`    | `/api/admin/...` | admin | accounts, api-configs, usage, logs, export |

## systemd unit (production)

```ini
# /etc/systemd/system/baize-api.service
[Unit]
Description=BaizeAI Backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/baize-api
EnvironmentFile=/etc/baize-api.env
ExecStart=/usr/bin/node /opt/baize-api/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/baize-api/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/baize-api.env`:
```
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
JWT_SECRET=<random 64-char>
COOKIE_SECURE=1
DB_PATH=/opt/baize-api/data/baize.db
```

`chmod 600 /etc/baize-api.env` to keep secrets safe.

## Backup

The whole DB is one file:

```bash
sqlite3 /opt/baize-api/data/baize.db ".backup /tmp/baize-$(date +%F).db"
```

Or use the admin UI: 「数据导出」→「⬇ 下载完整数据库」.
