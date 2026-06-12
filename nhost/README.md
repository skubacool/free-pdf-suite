# Nhost Backend Scaffolding

The PDF suite is fully client-side and ships with **no live backend** — this folder
is the designated home for the Nhost project config when you decide to enable
Authentication, Postgres/GraphQL, Storage or serverless Functions.

## Enabling the backend later

```bash
# from the repo root
nhost login          # if not already authenticated
nhost init           # scaffolds nhost/nhost.toml + migrations here
# or link an existing cloud project:
nhost link
nhost up             # local dev stack
```

Then open [`nhost.js`](../nhost.js) at the repo root and replace the placeholder
`subdomain` / `region` with your project's values. The frontend SDK
(`@nhost/nhost-js`) is already wired in `index.html` and loads lazily from CDN —
visitors download nothing until the config is filled in.

Suggested first features once enabled:
- **Auth**: user accounts for saved tool preferences / premium ad-free tier.
- **Postgres**: anonymous usage counters per tool (for ad-revenue optimization).
- **Storage**: optional cloud "send to device" hand-off for large files.
