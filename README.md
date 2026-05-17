# livespec

A tiny service for reviewing markdown documents — specs, plans, design notes — outside the chat window. POST a markdown file, get a URL. The reader hovers any paragraph to leave a comment or taps ✓ to approve. **Copy all** dumps every comment back into the conversation, quoted to the block it was attached to.

Built for the agent ↔ human spec-review loop: the agent writes a spec, the human reviews it in a browser at their own pace, the agent reads back the structured feedback and rewrites. No accounts, no setup.

## Free hosted service

A live instance runs at **<https://livespec.finereli.com>** — free to use for personal projects. The whole flow is just `curl`:

```bash
# Upload a doc — returns { id, editToken, url }
curl -X POST https://livespec.finereli.com --data @SPEC.md

# Replace it (same URL, comments are dropped — see spec)
curl -X PUT  https://livespec.finereli.com/<id> \
     -H "x-edit-token: <token>" \
     --data @SPEC.md

# Read the review back
curl https://livespec.finereli.com/api/docs/<id>/comments
```

A tiny Python CLI is included if you want it to remember edit tokens for you:

```bash
./livespec upload SPEC.md           # → URL, stores token in ~/.livespec/tokens.json
./livespec update <id> SPEC.md      # push a new version
./livespec comments <id>            # print the review as quoted markdown
```

## Self-host

Single Cloudflare Worker, single KV namespace, no build step.

```bash
wrangler kv namespace create livespec   # one-time
wrangler deploy
```

Worker source: [`src/worker.js`](src/worker.js). Full design notes: [SPEC.md](SPEC.md).

## License

MIT.
