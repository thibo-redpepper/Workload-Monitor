# CapacityHub dashboard

## Start lokaal

```bash
cd "/Users/thiboa3/Desktop/Projecten/Wrike Optimalisatie"
npm install
npm start
```

Open:

- Teamlid overzicht: `http://localhost:8788/`
- Management overzicht: `http://localhost:8788/management`

## Secrets (zonder database tabel)

Deze app leest Wrike credentials uit environment variables.

Zet deze keys in je secret store (bijv. Supabase Edge Functions Secrets):

- `WRIKE_HOST` (meestal `www.wrike.com`)
- `WRIKE_CLIENT_ID`
- `WRIKE_CLIENT_SECRET`
- `WRIKE_ACCESS_TOKEN`
- `WRIKE_REFRESH_TOKEN`

`WRIKE_TOKEN` is ook ondersteund als alias voor `WRIKE_ACCESS_TOKEN`.

`GET /api/health` toont `hasAccessToken` en `hasRefreshToken`.

Belangrijk:

- Draait backend op Netlify: zet dezelfde keys in Netlify Environment Variables.
- Draait backend als Supabase Edge Function: zet ze in Supabase Edge Functions Secrets.

## Netlify deploy

Deze repo bevat `netlify.toml` met:

- static publish uit project root
- redirects voor `/` en `/management`
- API rewrite van `/api/*` naar Netlify Function `netlify/functions/api.js`

Zet in Netlify onder Site settings -> Environment variables:

- `WRIKE_HOST`
- `WRIKE_CLIENT_ID`
- `WRIKE_CLIENT_SECRET`
- `WRIKE_ACCESS_TOKEN`
- `WRIKE_REFRESH_TOKEN`

## `.env` nog nodig?

Nee voor productie.  
Lokaal mag `.env/.env.local` nog steeds als fallback.

## Node versie

- Node.js 18+
