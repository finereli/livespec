# livespec

A tiny service for reviewing markdown documents (specs, plans, designs) outside the chat window. Upload markdown, get a URL, hover or tap any block to leave a comment or tick a green ✓, copy the whole review back into the conversation with one click.

## Why this exists

Reviewing long agent-produced specs inside a terminal/chat interface is painful. You scroll past things, lose your place, can't easily attach feedback to a specific paragraph. Rendering specs as HTML with per-block comments lets you read at your own pace and respond precisely.

## Goals

- Frictionless upload and update from an agent (one `curl` call, no auth setup).
- Identical, predictable UI on every document — muscle memory for the reviewer.
- Comments and approvals anchored to specific blocks; survive minor markdown edits.
- Reviewer can dump the whole review back into a conversation as quoted-context + body.
- Cheap to run, zero ops, no database — Cloudflare Worker + KV.

## Non-goals

- Multi-user auth, accounts, permissions. An edit token per doc is enough.
- Threaded discussions or replies. Each block holds a flat list of comments.
- Real-time collaboration. The workflow is one human reviewer ↔ one agent.
- Rich-text or WYSIWYG editing of the source markdown.
- Versioning / diffs of the document itself.

## Architecture

Single Cloudflare Worker (`src/worker.js`) backed by one KV namespace (`LIVESPEC`).

KV keys:

- `doc:{id}` — metadata: `{ title, editToken, currentVersion, versions: [{v, created}], created, updated }`
- `doc:{id}:v{n}` — `{ markdown, created }`
- `comments:{id}:v{n}` — JSON array. Each entry is either a comment (`type: "comment"`, has `body`) or an approval (`type: "approve"`, no body, at most one per `blockId` per author).

(Pre-versioning docs are read transparently: legacy `doc:{id}.markdown` and `comments:{id}` are treated as v1 until the next `PUT` migrates them into the versioned layout.)

IDs are 8 chars from a 32-char alphabet (no `0/1/l/o`). Edit tokens are 32 hex chars. Author IDs are generated client-side in `localStorage` so a browser can edit or delete its own entries.

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/` | none | Create a doc at v1. Returns `{id, editToken, version, url}`. |
| `GET` | `/:id` | none | Render current version. |
| `GET` | `/:id/v:n` | none | Render version `n` (read-only). |
| `PUT` | `/:id` | `x-edit-token` | Snapshot a new version `n+1`. |
| `DELETE` | `/api/docs/:id` | `x-edit-token` | Delete the doc and every version. |
| `GET` | `/api/docs/:id[/v:n]` | none | Fetch raw doc JSON for current or a specific version. Includes the `versions` list. |
| `GET` | `/api/docs/:id[/v:n]/comments` | none | List comments + approvals for current or a specific version. |
| `POST` | `/api/docs/:id/comments` | none | Add a comment, or toggle an approval (`type: "approve"`). Always targets current. |
| `PUT` | `/api/docs/:id/comments/:cid` | author | Edit a comment body (current version only). |
| `DELETE` | `/api/docs/:id/comments/:cid` | author or edit token | Remove a comment or approval (current version only). |

## Frontend

The server parses markdown with marked.js, walks the block tokens, and renders the full document body. Each top-level block (`h1–h6, p, li, pre, blockquote, table`) is wrapped in a `<div class="block-wrap" data-block-id="…">` with the action pills already in place. Lists are split into one wrap per `<li>`, each rewrapped in a fresh `<ul>`/`<ol>` so bullets and numbering stay correct.

The HTML reaches the browser fully rendered — no client-side markdown step, no parser download. The client script just walks `.block-wrap` elements, attaches handlers, and fetches the comments for the version it's looking at.

Block-level UI:

1. Hovering (desktop) or tapping (touch) a block reveals `+ comment` and `✓` pills at its bottom-right (under the table, for tables).
2. `+ comment` opens an inline editor under the block; multiple comments per block stack vertically. Each browser can edit and delete its own comments.
3. `✓` toggles an approval for the block. The UI flips instantly; the server call fires in the background.
4. The sticky topbar shows `N approved · M comment(s)`, a version chip, and a **Copy all** button that puts a clean quoted-context dump on the clipboard.

The page does not poll. Comments and approvals load once on page load. If the agent updates the doc, the human reloads.

## Versions and comment lifecycle

Every `PUT /:id` snapshots a new version of the doc. Old versions stay reachable, read-only, at `/:id/v:n`. The bare `/:id` always renders the latest.

- `POST /` creates the doc at v1.
- `PUT /:id` writes v(n+1). The new version starts with zero comments and zero approvals; the old version keeps its own.
- The topbar shows a version chip with a dropdown listing every version and how long ago it was written. Switching to an older version drops the page into read-only mode (no `+ comment`, no `✓`, no editing).
- Comment writes always target the current version. The server rejects mutations on `/api/docs/:id/v:n/...` for any `n` other than current.

This matches how the agent ↔ human loop already works — round by round. The reviewer's notes from v2 stay attached to v2 forever; v3 starts clean for the next pass — *except* for approvals, which carry forward on a block if its text didn't change. Approvals are claims about the content ("this block is fine"); if the content survives a rewrite untouched, the approval still applies. Comments are conversational and stay with the round they were written for.

Carry-forward works because the server is the single source of truth for blockIds — it renders the markdown, assigns each block a `b-{order}-{djb2(raw)}` id, and serves the HTML with those ids already baked in. On `PUT`, the server recomputes blockIds for the new markdown and copies any approval whose blockId is still present.

## Agent ↔ human flow

1. Agent produces a markdown spec, `POST /` → URL.
2. Agent shares the URL with the human.
3. Human reads in browser, leaves comments / ✓s, clicks **Copy all**, pastes the result back into the conversation.
4. Agent reads the pasted review, edits the spec, `PUT /:id` → same URL.
5. Human reloads the tab and continues.

Only the human writes to the comment store today. There's no flow for the agent to add its own comments or replies. **Open question:** is that worth building? The copy-paste round trip is cheap and visible; programmatic agent-side comments would be more powerful but add a moving part (the agent needs author identity, the human needs to distinguish their voice from the agent's, etc.).

## Tooling

The API is small enough that `curl` is the primary client. A tiny Python CLI (`./livespec`) is included for convenience — it stores edit tokens in `~/.livespec/tokens.json` so you don't have to track them yourself — but it's optional.

## Deployment

```bash
wrangler kv namespace create livespec   # one-time
wrangler deploy                          # ships worker
```

`wrangler.toml` pins the KV id and a custom-domain route at `livespec.finereli.com`. No build step, no framework, no bundler.

## Open questions

- **Agent-side write.** As above — let the agent post comments/replies, or keep it copy-paste only.
- **Lock current.** A "freeze the current version" toggle for when a review round is over but you don't want to bump a version yet.
- **Version pruning.** Cap retained versions to a sensible N to keep KV usage bounded for chatty docs.
- **Auth on update.** The edit token is currently the only gate on `PUT`. Fine for a personal tool; not fine if the URL leaks.
