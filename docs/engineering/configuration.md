# Configuration

The API reads `apps/murder-mystery-api/.env.production` when started in production mode. Important settings are:

- `AI_MURDER_MYSTERY_API_PORT`, default `3200`.
- `AI_MURDER_MYSTERY_SQLITE_PATH` and `AI_MURDER_MYSTERY_AGENT_DB`, relative to the repository unless absolute.
- `AI_MURDER_MYSTERY_AI_MODE`, either `live` or `mock`.
- `AI_MURDER_MYSTERY_MODEL_PROVIDER` and `AI_MURDER_MYSTERY_MODEL_NAME`.
- The provider API key, such as `DEEPSEEK_API_KEY`.

Live mode refuses to start AI rooms without the matching provider key. Do not commit production environment files or SQLite files.
