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

- `doc:{id}` — JSON `{ title, markdown, editToken, created, updated }`
- `comments:{id}` — JSON array. Each entry is either a comment (`type: "comment"`, has `body`) or an approval (`type: "approve"`, no body, at most one per `blockId` per author).

IDs are 8 chars from a 32-char alphabet (no `0/1/l/o`). Edit tokens are 32 hex chars. Author IDs are generated client-side in `localStorage` so a browser can edit or delete its own entries.

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/` | none | Create a doc. Body = raw markdown. Returns `{id, editToken, url}`. |
| `GET` | `/:id` | none | Rendered HTML view. |
| `PUT` | `/:id` | `x-edit-token` | Replace markdown. Wipes all comments and approvals (see below). |
| `DELETE` | `/api/docs/:id` | `x-edit-token` | Delete the doc. |
| `GET` | `/api/docs/:id` | none | Fetch raw doc JSON. |
| `GET` | `/api/docs/:id/comments` | none | List comments and approvals. |
| `POST` | `/api/docs/:id/comments` | none | Add a comment, or toggle an approval (`type: "approve"`). |
| `PUT` | `/api/docs/:id/comments/:cid` | author | Edit a comment body. |
| `DELETE` | `/api/docs/:id/comments/:cid` | author or edit token | Remove a comment or approval. |

## Frontend

Server returns one HTML page per doc. It embeds the markdown in a `<script type="text/markdown">` tag and renders client-side with [marked.js](https://marked.js.org/) from a CDN. After render:

1. Top-level blocks (`h1–h6, p, li, pre, blockquote, table`) get a stable id: `b-{index}-{djb2hash(textContent)}`. List items split into one block per `<li>`. Editing a block changes its hash and orphans its comments — see lifecycle below.
2. Hovering (desktop) or tapping (touch) a block reveals `+ comment` and `✓` pills at its bottom-right (under the table, for tables).
3. `+ comment` opens an inline editor under the block; multiple comments per block stack vertically. Each browser can edit and delete its own comments.
4. `✓` toggles an approval for the block. The UI flips instantly; the server call fires in the background.
5. The sticky topbar shows `N approved · M comment(s)` and a **Copy all** button that puts a clean quoted-context dump on the clipboard.

The page does not poll. Comments and approvals load once on page load. If the agent updates the doc, the human reloads.

## Comment lifecycle

- Comments live as long as the doc.
- `PUT /:id` (replacing the markdown) **clears every comment and approval**. The expectation is that the agent has already fetched the current review, applied the edits, and is uploading the post-review version.
- This keeps the model trivial: no orphan-detection, no block-by-block migration, no stale notes piling up. The reviewer's previous round is preserved in the conversation history (via *Copy all* → paste), not in the server.

Alternative considered: preserve approvals on blocks whose hash didn't change, but drop comments. Rejected for the MVP — adds an axis of behavior to reason about. Easy to add later if a use case appears.

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
- **Soft preserve approvals.** Keep ✓s across `PUT` when a block's hash didn't change.
- **Read-only / locked mode.** A flag on a doc to freeze comments after the review round closes.
- **Auth on update.** The edit token is currently the only gate on `PUT`. Fine for a personal tool; not fine if the URL leaks.
