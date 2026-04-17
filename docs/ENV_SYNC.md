# Keeping `.env` in sync with `.env.example`

After **any** change to `.env.example` (new keys, comments, reorder), run from the repo root:

```bash
npm run env:sync
```

This regenerates `.env` using `.env.example` as the template **and keeps your existing values** for keys you already had. You do not need to copy settings by hand.

Implementation: `scripts/env-sync.mjs` · npm script: `env:sync`.
