# livespec

Upload markdown, get a URL, collect per-block comments. Cloudflare Worker + KV.

Live at <https://livespec.finereli.com>. Full design notes in [SPEC.md](SPEC.md).

## Use

```bash
./livespec upload SPEC.md           # → URL, stores edit token in ~/.livespec/tokens.json
./livespec update <id> SPEC.md      # push a new version
./livespec comments <id>            # print comments as quoted markdown
```

Or with `curl`:

```bash
curl -X POST https://livespec.finereli.com/api/docs --data-binary @SPEC.md
curl -X PUT  https://livespec.finereli.com/api/docs/<id> \
  -H "x-edit-token: <token>" --data-binary @SPEC.md
curl https://livespec.finereli.com/api/docs/<id>/comments
```

## Develop

```bash
wrangler dev      # local
wrangler deploy   # ship
```

Worker is a single file: [`src/worker.js`](src/worker.js). No build step.
