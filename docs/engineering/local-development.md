# Local development

Install dependencies and start both applications:

```bash
pnpm install
pnpm start:local
```

The API binds to `127.0.0.1:3200`; Vite serves the Web app on `http://127.0.0.1:5173` and proxies `/api` to it. `start:local` loads `apps/murder-mystery-api/.env`, and stops the API when the foreground Web process exits. Environment variables already set in the shell take precedence over that file.

For separate terminals use `pnpm dev:api` and `pnpm dev:web`. `start:local` loads `.env`; separate API starts require the same variables in the shell. Tests explicitly use mock AI and do not require provider credentials.
