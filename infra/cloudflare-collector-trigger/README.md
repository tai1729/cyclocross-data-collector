# AJOCC collector external trigger

This Cloudflare Worker is an independent trigger for the existing
`cyclocross-data-collector` GitHub Actions workflow. It does not scrape or
write race data itself.

## Local verification

```sh
npm test
```

The Worker uses the scheduled-event interface documented by Cloudflare. A
local Wrangler test can invoke `/cdn-cgi/local/scheduled?format=json`; use a
test token only when testing the dispatch path locally.

## Cloudflare setup

1. In Cloudflare, create a Workers application from the
   `tai1729/cyclocross-data-collector` GitHub repository.
2. Set the root directory to `infra/cloudflare-collector-trigger`.
3. Deploy with the committed `wrangler.jsonc` configuration.
4. Add a Worker secret named `GITHUB_ACTIONS_TOKEN`. The value must be a
   fine-grained GitHub token limited to this repository with `Actions: write`.
5. Keep `DISPATCH_ENABLED=false` until the Cron Event is visible and the
   existing GitHub schedule is ready to be switched off.
6. At cutover, set `DISPATCH_ENABLED=true`, remove the GitHub `schedule`
   trigger in the collector workflow, and retain `workflow_dispatch`.

The Cron expression is `7 0-14 * * *` UTC, which corresponds to 09:07–23:07
JST. The Worker checks `race_days.json` at runtime and adds the following
calendar day before deciding whether to dispatch.
