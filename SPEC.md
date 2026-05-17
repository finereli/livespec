# livespec

A tiny service for reviewing markdown documents (specs, plans, designs) outside the chat window. Upload markdown, get a URL, hover over any block to leave a comment, copy all comments back into the conversation with one click.

## Why this exists

Reviewing long agent-produced specs inside a terminal/chat interface is painful. You scroll past things, lose your place, can't easily attach feedback to a specific paragraph. Rendering specs as HTML with per-block comments lets you read at your own pace and respond precisely.

The previous iteration generated standalone HTML files with localStorage-only comments. This version is a deployed service so the agent and the human share the same source of truth, and comments persist across browsers and devices.

## Goals

- Frictionless upload and update from an agent (one curl call, no auth setup).
- Identical, predictable UI on every document — muscle memory for the reviewer.
- Comments anchored to specific blocks of the document, survive minor edits.
- Reviewer can dump all comments back into a conversation as quoted-context + body.
- Cheap to run, zero ops, no database — Cloudflare Worker + KV.

## Non-goals (MVP)

- Multi-user auth, accounts, permissions. Edit token per doc is enough.
- Threaded discussions or replies. Each block holds one comment per browser.
- Real-time presence or live cursors. A 30s poll is fine.
- Rich-text or WYSIWYG editing of the source markdown.
- Versioning / diffs of the document itself.

## Architecture

Single Cloudflare Worker (`src/worker.js`) backed by one KV namespace (`LIVESPEC`).

KV keys:

- `doc:{id}` — JSON `{ title, markdown, editToken, created, updated }`
- `comments:{id}` — JSON array of `{ cid, blockId, anchor, body, author, order, created, updated }`

IDs are 8 chars from a 32-char alphabet (no `0/1/l/o`). Edit tokens are 32 hex chars. Author IDs are generated client-side and stored in `localStorage` so a browser can edit/delete its own comments.

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/` or `/api/docs` | none | Create a doc. Body = raw markdown. Returns `{id, editToken, url}`. |
| `GET` | `/:id` | none | Rendered HTML view. |
| `PUT` | `/:id` or `/api/docs/:id` | `x-edit-token` | Replace markdown. |
| `DELETE` | `/api/docs/:id` | `x-edit-token` | Delete doc + comments. |
| `GET` | `/api/docs/:id` | none | Fetch doc JSON. |
| `GET` | `/api/docs/:id/comments` | none | List comments + approvals. |
| `POST` | `/api/docs/:id/comments` | none | Add a comment (always new) or toggle an approval (`type: "approve"`). |
| `PUT` | `/api/docs/:id/comments/:cid` | author | Edit a comment body. |
| `DELETE` | `/api/docs/:id/comments/:cid?author=…` | author or edit token | Delete a comment or approval. |

## Frontend

Server returns an HTML page per doc. The page embeds the markdown in a `<script type="text/markdown">` tag and renders client-side with [marked.js](https://marked.js.org/) from a CDN. After render:

1. Walk top-level block elements (`h1–h6, p, ul, ol, pre, blockquote, table`).
2. Assign each a stable id: `b-{index}-{djb2hash(textContent)}`. Editing a block invalidates its id and orphans its comment — acceptable for MVP.
3. Hovering shows a 💬 button. Clicking opens an inline editor under the block. Save POSTs to `/api/docs/:id/comments`.
4. Side panel lists comments in document order, with "Copy all" (clipboard) and per-comment delete (own comments only).
5. Poll the comments endpoint every 30s so collaborators' notes appear.

## Agent workflow

A tiny Python CLI at `livespec` wraps the API and stores edit tokens in `~/.livespec/tokens.json`:

```
livespec upload SPEC.md           # prints the URL
livespec update <id> SPEC.md      # uses stored token
livespec comments <id>            # prints comments as quoted markdown
```

The agent uploads a spec, gives the human the URL, polls or asks for comments, applies them, and re-uploads with `update`. Round trips stay short and the conversation stays clean.

## Deployment

```bash
wrangler kv namespace create livespec   # one-time
wrangler deploy                          # ships worker
```

`wrangler.toml` pins the KV id and a custom-domain route at `livespec.finereli.com`. No build step, no framework, no bundler.

## Tradeoffs and open questions

- **Comment durability vs. doc edits.** Block hashes are stable as long as a block's text doesn't change. A heavier scheme (fuzzy match on edit, manual re-anchoring) would survive edits but adds significant complexity. MVP accepts orphaning.
- **Concurrency on comments.** A KV read-modify-write race could lose a comment if two people save in the same ~100ms. Acceptable at this scale; would move to Durable Objects if it bit us.
- **Spam / abuse.** Anyone with a URL can comment. URLs are unguessable (8 chars from a 32-char alphabet ≈ 40 bits) so this is link-secret, not access-controlled. Add a per-doc "comments closed" toggle if needed.
- **Rendering fidelity.** marked.js handles common GFM but not custom directives. Server-side render with a richer parser is a later optimization.
- **No history.** A `PUT` overwrites; old markdown and orphaned comments are lost. Keeping the last N versions in KV would be trivial if needed.

## What "done" looks like for the MVP

- `livespec.finereli.com` resolves to the worker.
- `curl -X POST .../api/docs --data-binary @file.md` returns a working URL.
- Opening the URL renders the document with the comment UI.
- Comments persist across page reloads and across browsers.
- "Copy all" produces a clean quoted-context dump suitable for pasting into a chat.

This document itself is the first real test.
