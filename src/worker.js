import { marked } from "marked";

// livespec — markdown documents with per-block comments.
// Storage (KV binding `LIVESPEC`):
//   doc:{id}        -> { title, markdown, editToken, created, updated }
//   comments:{id}   -> [ { cid, blockId, anchor, body, author, created } ]

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/1/l/o
const ID_LEN = 8;
const TOKEN_LEN = 32;

function randId(len = ID_LEN) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}
function randToken(len = TOKEN_LEN) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,x-edit-token,x-author",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      ...extra,
    },
  });
}
function notFound(msg = "not found") { return json({ error: msg }, 404); }
function bad(msg = "bad request") { return json({ error: msg }, 400); }
function forbidden(msg = "forbidden") { return json({ error: msg }, 403); }

function firstH1(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Untitled";
}

// --- markdown rendering ---------------------------------------------------
// Render once on the server. Returns an array of { blockId, isTable, isList,
// html } in document order. The client just inserts these into the page and
// reads blockIds off the elements — no client-side markdown parsing.

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const BLOCK_TYPES = new Set(["heading", "paragraph", "code", "blockquote", "table", "html"]);

function blockIdFor(idx, raw) {
  // Hash the raw markdown of the block. Stable across renders, sensitive to
  // any text change in the block.
  return "b-" + idx + "-" + djb2((raw || "").trim());
}

function renderBlocks(md) {
  const tokens = marked.lexer(md);
  const out = [];
  let idx = 0;
  for (const tok of tokens) {
    if (tok.type === "space" || tok.type === "hr") {
      // hr is rendered inline but isn't commentable.
      if (tok.type === "hr") out.push({ html: "<hr>", noBlock: true });
      continue;
    }
    if (tok.type === "list") {
      // One block per item; wrap each in a fresh list to preserve bullet/numbering.
      const tag = tok.ordered ? "ol" : "ul";
      const startBase = typeof tok.start === "number" ? tok.start : 1;
      for (let i = 0; i < tok.items.length; i++) {
        const item = tok.items[i];
        const itemHtml = marked.parse(item.raw || "").trim();
        // marked.parse wraps with a fresh <ul>/<ol>; renumber if ordered.
        let html = itemHtml;
        if (tok.ordered) {
          html = html.replace(/^<ol[^>]*>/, `<ol start="${startBase + i}">`);
        }
        out.push({
          blockId: blockIdFor(idx++, item.raw),
          isList: true,
          isTable: false,
          html,
        });
      }
    } else if (BLOCK_TYPES.has(tok.type)) {
      out.push({
        blockId: blockIdFor(idx++, tok.raw),
        isList: false,
        isTable: tok.type === "table",
        isHeading: tok.type === "heading",
        html: marked.parse(tok.raw || "").trim(),
      });
    }
  }
  return out;
}

// Server-side render of the full document body. Wraps each block in the
// scaffold the client expects, with data attributes for blockId / order /
// flags. Action pills and comments container are placeholders the client
// fills in.
function renderDocBody(md) {
  const blocks = renderBlocks(md);
  const parts = [];
  let order = 0;
  for (const b of blocks) {
    if (b.noBlock) { parts.push(b.html); continue; }
    // Headings render as plain HTML — no comment / approve pills (not useful).
    // Their blockId still exists in renderBlocks so non-heading blockIds stay
    // stable and carry-forward keeps working.
    if (b.isHeading) { parts.push(b.html); continue; }
    const wrapClass = "block-wrap" + (b.isList ? " is-list" : "");
    const textClass = "block-text" + (b.isTable ? " is-table" : "");
    let inner = b.html;
    if (b.isTable) inner = `<div class="table-scroll">${inner}</div>`;
    parts.push(
      `<div class="${wrapClass}" data-block-id="${b.blockId}" data-order="${order}">` +
        `<div class="${textClass}">` +
          inner +
          `<div class="block-actions">` +
            `<button class="pill add" type="button">+ comment</button>` +
            `<button class="pill approve" type="button" title="Approve this block"></button>` +
          `</div>` +
        `</div>` +
        `<div class="block-comments"></div>` +
      `</div>`
    );
    order++;
  }
  return parts.join("\n");
}

// Storage layout (versioned, with legacy fallback):
//   doc:{id}                -> { title, editToken, currentVersion, versions:[{v,created}],
//                                created, updated }
//   doc:{id}:v{n}           -> { markdown, created }
//   comments:{id}:v{n}      -> [ comment entries ]
// Legacy (pre-versioning): doc:{id} also carried .markdown for v1, and
// comments lived at comments:{id}. loadDoc synthesizes a v1 view of these
// records; the first PUT migrates them to the new layout.

async function loadDoc(env, id) {
  const raw = await env.LIVESPEC.get("doc:" + id);
  if (!raw) return null;
  const doc = JSON.parse(raw);
  if (typeof doc.currentVersion === "number") {
    if (!doc.versions) doc.versions = [{ v: doc.currentVersion, created: doc.created }];
    return doc;
  }
  // Legacy doc — virtual v1.
  return {
    title: doc.title,
    editToken: doc.editToken,
    currentVersion: 1,
    versions: [{ v: 1, created: doc.created }],
    created: doc.created,
    updated: doc.updated,
    _legacy: true,
    _legacyMarkdown: doc.markdown,
  };
}

async function loadMarkdown(env, id, doc, version) {
  if (version < 1 || version > doc.currentVersion) return null;
  if (doc._legacy && version === 1) return doc._legacyMarkdown;
  const raw = await env.LIVESPEC.get(`doc:${id}:v${version}`);
  return raw ? JSON.parse(raw).markdown : null;
}

async function loadVersionComments(env, id, doc, version) {
  const key = doc._legacy && version === 1
    ? "comments:" + id
    : `comments:${id}:v${version}`;
  const raw = await env.LIVESPEC.get(key);
  return raw ? JSON.parse(raw) : [];
}

async function saveCurrentComments(env, id, doc, arr) {
  // Mutations only ever happen on the current version.
  const v = doc.currentVersion;
  const key = doc._legacy && v === 1
    ? "comments:" + id
    : `comments:${id}:v${v}`;
  await env.LIVESPEC.put(key, JSON.stringify(arr));
}

async function createDoc(req, url, env) {
  const md = await req.text();
  if (!md.trim()) return bad("empty markdown");
  const id = randId();
  const editToken = randToken();
  const now = Date.now();
  await env.LIVESPEC.put(`doc:${id}:v1`, JSON.stringify({ markdown: md, created: now }));
  await env.LIVESPEC.put("doc:" + id, JSON.stringify({
    title: firstH1(md),
    editToken,
    currentVersion: 1,
    versions: [{ v: 1, created: now }],
    created: now,
    updated: now,
  }));
  const base = url.origin;
  return json({
    id, editToken, version: 1,
    url: `${base}/${id}`,
    rawUrl: `${base}/api/docs/${id}`,
    commentsUrl: `${base}/api/docs/${id}/comments`,
  }, 201);
}

async function updateDoc(req, env, id) {
  const doc = await loadDoc(env, id);
  if (!doc) return notFound("doc not found");
  if (req.headers.get("x-edit-token") !== doc.editToken) return forbidden("invalid edit token");
  const md = await req.text();
  if (!md.trim()) return bad("empty markdown");
  const now = Date.now();

  // Migrate legacy v1 in place so it stays reachable at /:id/v1 after the bump.
  if (doc._legacy) {
    await env.LIVESPEC.put(
      `doc:${id}:v1`,
      JSON.stringify({ markdown: doc._legacyMarkdown, created: doc.created }),
    );
    const legacyComments = await env.LIVESPEC.get("comments:" + id);
    if (legacyComments) {
      await env.LIVESPEC.put(`comments:${id}:v1`, legacyComments);
    }
  }

  const next = doc.currentVersion + 1;
  await env.LIVESPEC.put(`doc:${id}:v${next}`, JSON.stringify({ markdown: md, created: now }));

  // Carry forward approvals on blocks that still exist (same blockId) in the
  // new version. Comments do NOT carry forward — they belong to the round
  // they were written for.
  const prev = await loadVersionComments(env, id, doc, doc.currentVersion);
  const prevApprovals = prev.filter((c) => c.type === "approve");
  if (prevApprovals.length) {
    const newIds = new Set(renderBlocks(md).map((b) => b.blockId).filter(Boolean));
    const carried = prevApprovals
      .filter((a) => newIds.has(a.blockId))
      .map((a) => ({ ...a, cid: randId(10), created: now }));
    if (carried.length) {
      await env.LIVESPEC.put(`comments:${id}:v${next}`, JSON.stringify(carried));
    }
  }

  const versions = (doc.versions || []).concat([{ v: next, created: now }]);
  await env.LIVESPEC.put("doc:" + id, JSON.stringify({
    title: firstH1(md),
    editToken: doc.editToken,
    currentVersion: next,
    versions,
    created: doc.created,
    updated: now,
  }));
  return json({ id, version: next, title: firstH1(md), updated: now });
}

async function deleteDocAndAll(env, id, doc) {
  // Wipe everything for this id.
  await env.LIVESPEC.delete("doc:" + id);
  await env.LIVESPEC.delete("comments:" + id); // legacy
  for (const { v } of doc.versions || []) {
    await env.LIVESPEC.delete(`doc:${id}:v${v}`);
    await env.LIVESPEC.delete(`comments:${id}:v${v}`);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return json({}, 204);

    // Static assets — content-hashed URL, served with a long cache.
    if (pathname === "/assets/app.css" && req.method === "GET") {
      return new Response(DOC_CSS, {
        headers: {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
    if (pathname === "/assets/app.js" && req.method === "GET") {
      return new Response(DOC_JS, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    // Root: GET → landing, POST → create doc.
    if (pathname === "/" || pathname === "") {
      if (req.method === "POST") return createDoc(req, url, env);
      if (req.method === "GET") {
        return new Response(LANDING_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    }
    // API alias for create.
    if (pathname === "/api/docs" && req.method === "POST") {
      return createDoc(req, url, env);
    }

    // --- API: doc routes /api/docs/:id[/v:n][/comments[/:cid]] ---
    const apiMatch = pathname.match(
      /^\/api\/docs\/([a-z0-9]{4,})(?:\/v(\d+))?(?:\/(comments)(?:\/([a-z0-9]{4,}))?)?$/,
    );
    if (apiMatch) {
      const [, id, vstr, sub, cid] = apiMatch;
      const requestedVersion = vstr ? parseInt(vstr, 10) : null;
      const doc = await loadDoc(env, id);
      if (!doc) return notFound("doc not found");

      const effective = requestedVersion ?? doc.currentVersion;
      if (effective < 1 || effective > doc.currentVersion) return notFound("version not found");

      const isMutation = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
      if (isMutation && requestedVersion !== null && requestedVersion !== doc.currentVersion) {
        return forbidden("old versions are read-only");
      }

      // GET doc (raw json)
      if (!sub && req.method === "GET") {
        const md = await loadMarkdown(env, id, doc, effective);
        if (md === null) return notFound("version not found");
        return json({
          id,
          version: effective,
          currentVersion: doc.currentVersion,
          versions: doc.versions,
          title: doc.title,
          markdown: md,
          created: doc.created,
          updated: doc.updated,
        });
      }
      // PUT doc → bump version (only on /api/docs/:id, no /v:n)
      if (!sub && req.method === "PUT") {
        if (requestedVersion !== null) return forbidden("PUT a new version via /api/docs/:id (no /v:n)");
        return updateDoc(req, env, id);
      }
      if (!sub && req.method === "DELETE") {
        if (requestedVersion !== null) return forbidden("cannot delete a single version");
        if (req.headers.get("x-edit-token") !== doc.editToken) return forbidden("invalid edit token");
        await deleteDocAndAll(env, id, doc);
        return json({ ok: true });
      }

      // Comments — reads can target any version; writes always hit current.
      if (sub === "comments" && !cid && req.method === "GET") {
        return json(await loadVersionComments(env, id, doc, effective));
      }
      if (sub === "comments" && !cid && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.blockId) return bad("blockId required");
        const author = body.author || "anon";
        const type = body.type === "approve" ? "approve" : "comment";
        const comments = await loadVersionComments(env, id, doc, doc.currentVersion);
        if (type === "approve") {
          const idx = comments.findIndex(
            (c) => c.type === "approve" && c.blockId === body.blockId && c.author === author,
          );
          if (idx >= 0) {
            comments.splice(idx, 1);
            await saveCurrentComments(env, id, doc, comments);
            return json({ ok: true, approved: false });
          }
          const entry = {
            cid: randId(10), type: "approve",
            blockId: body.blockId,
            anchor: (body.anchor || "").slice(0, 500),
            author,
            order: typeof body.order === "number" ? body.order : 0,
            created: Date.now(),
          };
          comments.push(entry);
          await saveCurrentComments(env, id, doc, comments);
          return json({ ok: true, approved: true, cid: entry.cid }, 201);
        }
        if (!body.body) return bad("body required for comment");
        const entry = {
          cid: randId(10), type: "comment",
          blockId: body.blockId,
          anchor: (body.anchor || "").slice(0, 500),
          body: String(body.body).slice(0, 5000),
          author,
          order: typeof body.order === "number" ? body.order : 0,
          created: Date.now(),
          updated: Date.now(),
        };
        comments.push(entry);
        await saveCurrentComments(env, id, doc, comments);
        return json(entry, 201);
      }
      if (sub === "comments" && cid && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body || !body.body) return bad("body required");
        const author = body.author || req.headers.get("x-author");
        const editToken = req.headers.get("x-edit-token");
        const comments = await loadVersionComments(env, id, doc, doc.currentVersion);
        const idx = comments.findIndex((c) => c.cid === cid);
        if (idx < 0) return notFound("comment not found");
        const c = comments[idx];
        if (c.type !== "comment") return bad("only comments can be edited");
        if (c.author !== author && editToken !== doc.editToken) return forbidden("not your comment");
        c.body = String(body.body).slice(0, 5000);
        c.updated = Date.now();
        await saveCurrentComments(env, id, doc, comments);
        return json(c);
      }
      if (sub === "comments" && cid && req.method === "DELETE") {
        const author = req.headers.get("x-author") || url.searchParams.get("author");
        const editToken = req.headers.get("x-edit-token");
        const comments = await loadVersionComments(env, id, doc, doc.currentVersion);
        const idx = comments.findIndex((c) => c.cid === cid);
        if (idx < 0) return notFound("comment not found");
        const c = comments[idx];
        if (c.author !== author && editToken !== doc.editToken) {
          return forbidden("not your comment");
        }
        comments.splice(idx, 1);
        await saveCurrentComments(env, id, doc, comments);
        return json({ ok: true });
      }
    }

    // --- /:id[/v:n] — GET renders HTML; PUT /:id updates markdown (edit token required). ---
    const docMatch = pathname.match(/^\/([a-z0-9]{4,})(?:\/v(\d+))?\/?$/);
    if (docMatch) {
      const id = docMatch[1];
      const vstr = docMatch[2];
      if (req.method === "PUT") {
        if (vstr) return forbidden("PUT a new version via /:id (no /v:n)");
        return updateDoc(req, env, id);
      }
      if (req.method === "GET") {
        const doc = await loadDoc(env, id);
        if (!doc) return new Response("Not found", { status: 404 });
        const requestedVersion = vstr ? parseInt(vstr, 10) : doc.currentVersion;
        if (requestedVersion < 1 || requestedVersion > doc.currentVersion) {
          return new Response("Version not found", { status: 404 });
        }
        const md = await loadMarkdown(env, id, doc, requestedVersion);
        if (md === null) return new Response("Version not found", { status: 404 });
        const html = renderHtml(id, doc, requestedVersion, md);
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    }

    return notFound();
  },
};

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderHtml(id, doc, viewingVersion, markdown) {
  const title = escapeHtml(doc.title || "Untitled");
  const body = renderDocBody(markdown);
  const isReadonly = viewingVersion !== doc.currentVersion;
  const config = {
    docId: id,
    viewingVersion,
    currentVersion: doc.currentVersion,
    versions: doc.versions || [],
    readonly: isReadonly,
  };
  return TEMPLATE
    .replace(/__TITLE__/g, title)
    .replace(/__DOC_ID__/g, id)
    .replace(/__VIEWING_VERSION__/g, String(viewingVersion))
    .replace(/__ASSET_VER__/g, ASSET_VER)
    .replace("__CONFIG_JSON__", JSON.stringify(config))
    .replace("__DOC_BODY__", body);
}

function djb2Hex(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const DOC_CSS = `
  :root {
    --bg: #fafaf7; --fg: #1a1a1a; --muted: #7a7569;
    --rule: #e4e2dc; --accent: #b8541a; --accent-2: #8a3e13;
    --accent-bg: #fdf1e7; --code-bg: #f0ede4;
    --approve: #4a7a3a; --approve-bg: #ecf3e6;
    --link: var(--accent);
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1a1a1a; --fg: #e8e6e0; --muted: #9a948a;
      --rule: #333; --accent: #e08a4a; --accent-2: #f5a368;
      --accent-bg: #2a1d12; --code-bg: #252525;
      --approve: #7aa86a; --approve-bg: #1d2a18; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }

  a { color: var(--link); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--link) 40%, transparent); text-underline-offset: 2px; }
  a:hover { text-decoration-color: var(--link); }

  .topbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 16px; gap: 10px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(6px);
    border-bottom: 1px solid var(--rule);
    font-size: 13px;
  }
  .topbar .brand { color: var(--muted); text-decoration: none; margin-right: auto; font-weight: 600; }
  .topbar .brand:hover { color: var(--accent); }
  .topbar .count { color: var(--muted); }
  .version-menu { position: relative; }
  .version-toggle { font: inherit; font-size: 12px; padding: 4px 10px;
    background: var(--bg); color: var(--muted); border: 1px solid var(--rule);
    border-radius: 4px; cursor: pointer; }
  .version-toggle:hover { border-color: var(--accent); color: var(--accent); }
  .version-toggle .caret { font-size: 9px; margin-left: 2px; }
  .version-list { position: absolute; top: calc(100% + 4px); right: 0;
    min-width: 180px; max-height: 50vh; overflow-y: auto;
    background: var(--bg); border: 1px solid var(--rule); border-radius: 6px;
    padding: 4px; display: none; z-index: 20;
    box-shadow: 0 6px 18px rgba(0,0,0,.15); }
  .version-list.open { display: block; }
  .version-list a { display: flex; justify-content: space-between; gap: 12px;
    padding: 6px 10px; color: var(--fg); text-decoration: none; border-radius: 4px;
    font-size: 13px; }
  .version-list a:hover { background: var(--accent-bg); }
  .version-list a.current { font-weight: 600; }
  .version-list a.viewing { color: var(--accent); }
  .version-list .when { color: var(--muted); font-size: 11px; }

  .readonly-banner { background: #fff4d6; color: #6b5300;
    padding: 8px 16px; font-size: 13px; text-align: center;
    border-bottom: 1px solid #e9d780; }
  .readonly-banner a { color: #6b5300; }
  @media (prefers-color-scheme: dark) {
    .readonly-banner { background: #3a2e10; color: #f0d690;
      border-bottom-color: #5a4820; }
    .readonly-banner a { color: #f0d690; }
  }

  /* In readonly mode, hide the editor affordances entirely. */
  body.readonly .block-actions, body.readonly .inline-comment .del { display: none !important; }
  body.readonly .inline-comment.mine { cursor: default; }
  body.readonly #copy-all { display: none; }
  .doc-footer {
    max-width: 760px; margin: 40px auto 24px; padding: 16px 24px 0;
    border-top: 1px solid var(--rule); color: var(--muted); font-size: 12px;
  }
  .doc-footer a { color: var(--muted); }

  main { max-width: 760px; margin: 0 auto; padding: 28px 24px 120px; }

  button { font: inherit; font-size: 12px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--rule); border-radius: 4px; padding: 4px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.primary:hover { opacity: .9; color: white; }

  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 .4em; }
  h1 { font-size: 2em; border-bottom: 1px solid var(--rule); padding-bottom: .3em; }
  h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
  p { margin: .8em 0; }
  code { background: var(--code-bg); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
  pre { background: var(--code-bg); padding: 14px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid var(--accent); margin: 1em 0; padding: .3em 1em; color: var(--muted); }
  ul, ol { padding-left: 1.6em; }
  table { border-collapse: collapse; } th, td { border: 1px solid var(--rule); padding: 6px 10px; }
  .table-scroll { overflow-x: auto; }
  /* Tables: keep the action pills below the table so they never collide with cells. */
  .block-text.is-table .block-actions {
    position: static; justify-content: flex-end;
    margin-top: 8px; padding-bottom: 2px;
    pointer-events: auto;
  }
  .block-text.is-table { padding-bottom: 4px; }

  .block-wrap { margin: 0; }
  .block-text {
    position: relative;
    padding: 2px 8px 2px 8px;
    margin: 0 -8px;
    border-radius: 4px;
    transition: background .12s;
  }
  .block-text > :first-child { margin-top: .3em; }
  .block-text > :last-child { margin-bottom: .3em; }
  @media (hover: hover) {
    .block-text:hover { background: var(--accent-bg); }
  }
  .block-wrap.selected .block-text { background: var(--accent-bg); }

  /* Actions sit at the bottom-right of the block, overlapping the last line if there's room. */
  .block-actions {
    position: absolute; right: 4px; bottom: 2px;
    display: flex; gap: 4px; align-items: center;
    pointer-events: none;
  }
  .pill {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: var(--bg); color: var(--muted);
    border: 1px solid var(--rule);
    cursor: pointer; line-height: 1.4;
    transition: opacity .12s, color .1s, background .1s, border-color .1s;
  }
  .pill:hover { color: var(--accent); border-color: var(--accent); }
  .add { opacity: 0; }
  @media (hover: hover) { .block-text:hover .add { opacity: .9; pointer-events: auto; } }
  .block-wrap.selected .add { opacity: 1; pointer-events: auto; }
  .add:hover { opacity: 1 !important; background: var(--accent); color: white; border-color: var(--accent); }

  .approve { opacity: 0; }
  .approve.has-any { opacity: .85; pointer-events: auto; }
  @media (hover: hover) { .block-text:hover .approve { opacity: 1; pointer-events: auto; } }
  .block-wrap.selected .approve { opacity: 1; pointer-events: auto; }
  .approve.mine { background: var(--approve); color: white; border-color: var(--approve); opacity: 1; pointer-events: auto; }
  .approve.mine:hover { background: var(--approve); color: white; border-color: var(--approve); }
  .approve:hover { color: var(--approve); border-color: var(--approve); }

  .block-comments { margin: 4px 0 12px; }
  /* Align comments with the text of a list item, not the bullet. */
  .block-wrap.is-list > .block-comments { padding-left: 1.6em; }
  .inline-comment {
    font-size: 13px; font-style: italic; color: var(--muted);
    border-left: 2px solid var(--accent);
    padding: 4px 10px; margin: 4px 0;
    background: color-mix(in srgb, var(--accent-bg) 55%, transparent);
    border-radius: 0 4px 4px 0;
    display: flex; gap: 6px; align-items: flex-start;
  }
  .inline-comment .body { flex: 1; white-space: pre-wrap; }
  .inline-comment.mine { cursor: pointer; }
  .inline-comment.mine:hover { background: var(--accent-bg); color: var(--fg); }
  .inline-comment.editing { display: none; }
  .inline-comment .del {
    font-style: normal; font-size: 12px; padding: 0 6px; opacity: 0;
    background: transparent; border: none; color: var(--muted); cursor: pointer;
    line-height: 1;
  }
  .inline-comment.mine:hover .del { opacity: 1; }
  .inline-comment .del:hover { color: var(--accent); }

  .editor { margin: 6px 0 12px; padding: 10px; background: var(--accent-bg);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 6px; }
  .editor textarea { width: 100%; font: inherit; font-size: 14px; line-height: 1.5;
    background: var(--bg); color: var(--fg); border: 1px solid var(--rule);
    border-radius: 4px; padding: 6px 8px; resize: none; overflow: hidden;
    outline: none; transition: border-color .1s, box-shadow .1s; }
  .editor textarea:focus {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--rule));
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .editor .row { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; align-items: center; }
  .editor .status { font-size: 12px; color: var(--muted); margin-right: auto; }

  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--fg); color: var(--bg); padding: 8px 16px; border-radius: 4px;
    font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }
  .toast.err { background: #c53030; color: white; }

  @media (max-width: 700px) {
    main { padding: 16px 12px 100px; max-width: none; }
    body { font-size: 15px; }
    h1 { font-size: 1.55em; } h2 { font-size: 1.25em; } h3 { font-size: 1.1em; }
    .topbar { padding: 8px 12px; }
    .block-actions { right: 2px; bottom: 2px; }
    .pill { padding: 3px 10px; font-size: 12px; }
  }
`;

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>__TITLE__ — livespec</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgNTEyIDUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBpZD0iaWNvbiI+PHJlY3QgeD0iMzIiIHk9IjMyIiB3aWR0aD0iNDQ4IiBoZWlnaHQ9IjQ0OCIgcng9IjcyIiBmaWxsPSIjMWUyOTNiIi8+PHBhdGggZD0iTTEyMCAxMjggSDE3NiBWMTYwIEgxNTIgVjM1MiBIMTc2IFYzODQgSDEyMCBaIiBmaWxsPSIjZDlmOTlkIi8+PHBhdGggZD0iTTM5MiAxMjggSDMzNiBWMTYwIEgzNjAgVjM1MiBIMzM2IFYzODQgSDM5MiBaIiBmaWxsPSIjZDlmOTlkIi8+PHJlY3QgeD0iMTkyIiB5PSIxODQiIHdpZHRoPSIxMjgiIGhlaWdodD0iMjgiIHJ4PSIxNCIgZmlsbD0iI2Y4ZmFmYyIvPjxyZWN0IHg9IjE5MiIgeT0iMjQyIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjI4IiByeD0iMTQiIGZpbGw9IiNmOGZhZmMiLz48cmVjdCB4PSIxOTIiIHk9IjMwMCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjI4IiByeD0iMTQiIGZpbGw9IiNiZWYyNjQiLz48L2c+PC9zdmc+">
<link rel="stylesheet" href="/assets/app.css?v=__ASSET_VER__">
</head>
<body>
<div class="topbar">
  <a class="brand" href="/">livespec</a>
  <span class="count"><span id="approve-count">0</span>/<span id="block-total">0</span> approved · <span id="count">0</span> <span id="count-label">comments</span></span>
  <div class="version-menu">
    <button id="version-toggle" class="version-toggle" type="button">v__VIEWING_VERSION__ <span class="caret">▾</span></button>
    <div id="version-list" class="version-list"></div>
  </div>
  <button id="copy-all" class="primary">Copy all</button>
</div>
<div id="readonly-banner" class="readonly-banner" hidden>
  Read-only · viewing v<span id="rb-viewing">?</span> of <span id="rb-current">?</span>.
  <a id="rb-latest" href="/__DOC_ID__">Go to latest →</a>
</div>
<main id="content">
__DOC_BODY__
</main>
<footer class="doc-footer">__DOC_ID__ · v__VIEWING_VERSION__</footer>
<div class="toast" id="toast"></div>
<script>window.LIVESPEC = __CONFIG_JSON__;</script>
<script src="/assets/app.js?v=__ASSET_VER__" defer></script>
</body>
</html>`;

const DOC_JS = `(function () {
  const CFG = window.LIVESPEC;
  const DOC_ID = CFG.docId;
  const VIEWING_VERSION = CFG.viewingVersion;
  const CURRENT_VERSION = CFG.currentVersion;
  const VERSIONS = CFG.versions;
  const READONLY = CFG.readonly;
  // Comments are always fetched for the version being viewed; mutations always
  // hit current. Since the page is locked to one version, just compute the URL.
  const API = "/api/docs/" + DOC_ID + "/v" + VIEWING_VERSION + "/comments";

  if (READONLY) document.body.classList.add("readonly");

  // Readonly banner setup.
  if (READONLY) {
    const banner = document.getElementById("readonly-banner");
    document.getElementById("rb-viewing").textContent = VIEWING_VERSION;
    document.getElementById("rb-current").textContent = CURRENT_VERSION;
    banner.hidden = false;
  }

  // Version menu.
  (function () {
    const toggle = document.getElementById("version-toggle");
    const list = document.getElementById("version-list");
    const fmt = (ms) => {
      const d = new Date(ms);
      const now = Date.now();
      const diff = (now - ms) / 1000;
      if (diff < 60) return "just now";
      if (diff < 3600) return Math.floor(diff / 60) + "m ago";
      if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
      if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
      return d.toISOString().slice(0, 10);
    };
    const sorted = VERSIONS.slice().sort((a, b) => b.v - a.v);
    for (const ver of sorted) {
      const a = document.createElement("a");
      a.href = ver.v === CURRENT_VERSION ? "/" + DOC_ID : "/" + DOC_ID + "/v" + ver.v;
      const isCurrent = ver.v === CURRENT_VERSION;
      const isViewing = ver.v === VIEWING_VERSION;
      a.className = (isCurrent ? "current " : "") + (isViewing ? "viewing" : "");
      a.innerHTML = '<span>v' + ver.v + (isCurrent ? ' (latest)' : '') + '</span><span class="when"></span>';
      a.querySelector(".when").textContent = fmt(ver.created);
      list.appendChild(a);
    }
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      list.classList.toggle("open");
    });
    document.addEventListener("click", () => list.classList.remove("open"));
  })();

  let AUTHOR = localStorage.getItem("livespec:author");
  if (!AUTHOR) {
    AUTHOR = "u-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("livespec:author", AUTHOR);
  }

  const content = document.getElementById("content");
  const countEl = document.getElementById("count");
  const toast = document.getElementById("toast");

  function showToast(msg, err) {
    toast.textContent = msg;
    toast.classList.toggle("err", !!err);
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 1800);
  }
  function snippet(wrap, n) {
    // Read only the source block text — exclude action pills and any rendered comments.
    const text = wrap.querySelector(".block-text");
    if (!text) return "";
    const clone = text.cloneNode(true);
    clone.querySelectorAll(".block-actions").forEach((el) => el.remove());
    const t = clone.textContent.replace(/\\s+/g, " ").trim();
    return t.length > (n || 200) ? t.slice(0, n || 200) + "…" : t;
  }

  // The document body is already rendered by the server, with block-wraps and
  // action pills in place. Hydrate by wiring event handlers.
  const wraps = [...content.querySelectorAll(":scope > .block-wrap")];
  const wrapById = Object.fromEntries(wraps.map((w) => [w.dataset.blockId, w]));
  document.getElementById("block-total").textContent = wraps.length;
  for (const wrap of wraps) {
    const addBtn = wrap.querySelector(".pill.add");
    const approveBtn = wrap.querySelector(".pill.approve");
    if (addBtn) addBtn.addEventListener("click", (e) => { e.stopPropagation(); openEditor(wrap, null); });
    if (approveBtn) approveBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleApprove(wrap); });
  }

  // Touch-only: tap a block to reveal the action pills. Desktop hover handles this in CSS.
  const TOUCH = matchMedia("(hover: none)").matches;
  if (TOUCH) {
    let selected = null;
    function select(wrap) {
      if (selected && selected !== wrap) selected.classList.remove("selected");
      selected = wrap;
      if (wrap) wrap.classList.add("selected");
    }
    document.addEventListener("click", (e) => {
      if (e.target.closest(".editor, .pill, .inline-comment")) return;
      const wrap = e.target.closest(".block-wrap");
      if (wrap) {
        if (window.getSelection && !window.getSelection().isCollapsed) return;
        select(wrap);
      } else {
        select(null);
      }
    });
  }

  let COMMENTS = [];

  async function refresh() {
    // Don't redraw while the user is mid-edit — would wipe open editors and steal scroll/focus.
    if (document.querySelector(".editor")) return;
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      COMMENTS = await res.json();
      renderAll();
    } catch (e) {
      showToast("Failed to load comments", true);
    }
  }

  function toggleApprove(wrap) {
    // Optimistic: flip local state and re-render immediately; fire-and-forget the server call.
    const blockId = wrap.dataset.blockId;
    const idx = COMMENTS.findIndex(
      (c) => c.type === "approve" && c.blockId === blockId && c.author === AUTHOR,
    );
    if (idx >= 0) {
      COMMENTS.splice(idx, 1);
    } else {
      COMMENTS.push({
        cid: "tmp-" + Math.random().toString(36).slice(2, 8),
        type: "approve", blockId, author: AUTHOR,
        anchor: snippet(wrap),
        order: Number(wrap.dataset.order),
        created: Date.now(),
      });
    }
    renderAll();
    fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "approve",
        blockId,
        anchor: snippet(wrap),
        author: AUTHOR,
        order: Number(wrap.dataset.order),
      }),
    }).then(() => refresh()).catch(() => showToast("Approve failed", true));
  }

  function openEditor(wrap, editingCid) {
    // If an editor for the same slot is already open, just focus it.
    const existing = wrap.querySelector('.editor[data-editing="' + (editingCid || "new") + '"]');
    if (existing) { existing.querySelector("textarea").focus(); return; }
    // Hide the inline comment being edited (if any).
    const editingEl = editingCid ? wrap.querySelector('.inline-comment[data-cid="' + editingCid + '"]') : null;
    if (editingEl) editingEl.classList.add("editing");

    const editor = document.createElement("div");
    editor.className = "editor";
    editor.dataset.editing = editingCid || "new";
    editor.innerHTML =
      '<textarea rows="1" placeholder="Comment on this block…"></textarea>' +
      '<div class="row"><span class="status"></span>' +
      '<button class="cancel" type="button">Cancel</button>' +
      '<button class="primary save" type="button">Save</button></div>';
    const ta = editor.querySelector("textarea");
    const status = editor.querySelector(".status");
    const saveBtn = editor.querySelector(".save");
    if (editingCid) {
      const c = COMMENTS.find((x) => x.cid === editingCid);
      if (c) ta.value = c.body;
    }
    // Autogrow.
    const autosize = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    ta.addEventListener("input", autosize);
    // Desktop: Enter submits, Shift+Enter inserts newline. Touch: Enter always newlines.
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !TOUCH) {
        e.preventDefault();
        saveBtn.click();
      }
    });
    // Run autosize after the textarea is in the DOM (scrollHeight is 0 otherwise).
    queueMicrotask(autosize);
    editor.querySelector(".cancel").addEventListener("click", (e) => {
      e.stopPropagation();
      if (editingEl) editingEl.classList.remove("editing");
      editor.remove();
    });
    editor.querySelector(".save").addEventListener("click", async (e) => {
      e.stopPropagation();
      const text = ta.value.trim();
      if (!text) { status.textContent = "Empty"; return; }
      status.textContent = "Saving…";
      try {
        if (editingCid) {
          await fetch(API + "/" + editingCid, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: text, author: AUTHOR }),
          });
        } else {
          await fetch(API, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "comment",
              blockId: wrap.dataset.blockId,
              anchor: snippet(wrap),
              body: text,
              author: AUTHOR,
              order: Number(wrap.dataset.order),
            }),
          });
        }
        editor.remove();
        await refresh();
      } catch (err) {
        status.textContent = "";
        showToast("Save failed", true);
      }
    });
    editor.addEventListener("click", (e) => e.stopPropagation());
    // Editing an existing comment: drop the editor in the comment's slot.
    // New comments: append at the bottom of the comments list.
    if (editingEl) {
      editingEl.before(editor);
    } else {
      wrap.querySelector(":scope > .block-comments").appendChild(editor);
    }
    ta.focus();
    ta.selectionStart = ta.value.length;
  }

  function renderAll() {
    const onlyComments = COMMENTS.filter((c) => (c.type || "comment") === "comment");
    countEl.textContent = onlyComments.length;
    document.getElementById("count-label").textContent = onlyComments.length === 1 ? "comment" : "comments";
    const approvedBlockIds = new Set(COMMENTS.filter((c) => c.type === "approve").map((c) => c.blockId));
    document.getElementById("approve-count").textContent = approvedBlockIds.size;
    const sorted = COMMENTS.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.created - b.created);
    const cmtByBlock = {}, apprByBlock = {};
    for (const c of sorted) {
      if ((c.type || "comment") === "approve") {
        (apprByBlock[c.blockId] = apprByBlock[c.blockId] || []).push(c);
      } else {
        (cmtByBlock[c.blockId] = cmtByBlock[c.blockId] || []).push(c);
      }
    }
    for (const wrap of wraps) {
      // Approvals
      const apps = apprByBlock[wrap.dataset.blockId] || [];
      const mine = apps.some((a) => a.author === AUTHOR);
      const approveBtn = wrap.querySelector(".approve");
      approveBtn.classList.toggle("has-any", apps.length > 0);
      approveBtn.classList.toggle("mine", mine);
      approveBtn.textContent = "✓" + (apps.length > 1 ? " " + apps.length : "");

      // Comments
      const list = cmtByBlock[wrap.dataset.blockId] || [];
      const container = wrap.querySelector(":scope > .block-comments");
      container.innerHTML = "";
      for (const c of list) {
        const div = document.createElement("div");
        const isMine = !READONLY && c.author === AUTHOR;
        div.className = "inline-comment" + (isMine ? " mine" : "");
        div.dataset.cid = c.cid;
        div.innerHTML =
          '<span class="body"></span>' +
          (isMine ? '<button class="del" type="button" title="Delete">×</button>' : "");
        div.querySelector(".body").textContent = c.body;
        if (isMine) {
          div.addEventListener("click", (e) => {
            if (e.target.classList.contains("del")) return;
            openEditor(wrap, c.cid);
          });
          div.querySelector(".del").addEventListener("click", async (e) => {
            e.stopPropagation();
            await fetch(API + "/" + c.cid + "?author=" + AUTHOR, { method: "DELETE" });
            await refresh();
          });
        }
        container.appendChild(div);
      }
    }
  }

  document.getElementById("copy-all").addEventListener("click", async () => {
    // Approvals are for the human reviewer's tracking. The agent only needs
    // the comments — the things they actually have to act on.
    const cmts = COMMENTS
      .filter((c) => (c.type || "comment") === "comment")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!cmts.length) { showToast("No comments to copy"); return; }
    const out = ["# Comments on: " + document.title.replace(/ — livespec$/, ""), ""];
    const byBlock = {};
    for (const c of cmts) {
      const g = byBlock[c.blockId] = byBlock[c.blockId] || { anchor: c.anchor, order: c.order, items: [] };
      g.items.push(c.body);
    }
    const groups = Object.entries(byBlock).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
    for (const [, g] of groups) {
      out.push("> " + g.anchor.split("\\n").join("\\n> "));
      out.push("");
      for (const body of g.items) out.push(body);
      out.push("");
      out.push("---");
      out.push("");
    }
    const text = out.join("\\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove();
    }
    showToast("Copied " + groups.length + " block(s)");
  });

  refresh();
})();
`;

const ASSET_VER = djb2Hex(DOC_CSS) + djb2Hex(DOC_JS);

const LANDING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>livespec — review markdown documents</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgNTEyIDUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBpZD0iaWNvbiI+PHJlY3QgeD0iMzIiIHk9IjMyIiB3aWR0aD0iNDQ4IiBoZWlnaHQ9IjQ0OCIgcng9IjcyIiBmaWxsPSIjMWUyOTNiIi8+PHBhdGggZD0iTTEyMCAxMjggSDE3NiBWMTYwIEgxNTIgVjM1MiBIMTc2IFYzODQgSDEyMCBaIiBmaWxsPSIjZDlmOTlkIi8+PHBhdGggZD0iTTM5MiAxMjggSDMzNiBWMTYwIEgzNjAgVjM1MiBIMzM2IFYzODQgSDM5MiBaIiBmaWxsPSIjZDlmOTlkIi8+PHJlY3QgeD0iMTkyIiB5PSIxODQiIHdpZHRoPSIxMjgiIGhlaWdodD0iMjgiIHJ4PSIxNCIgZmlsbD0iI2Y4ZmFmYyIvPjxyZWN0IHg9IjE5MiIgeT0iMjQyIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjI4IiByeD0iMTQiIGZpbGw9IiNmOGZhZmMiLz48cmVjdCB4PSIxOTIiIHk9IjMwMCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjI4IiByeD0iMTQiIGZpbGw9IiNiZWYyNjQiLz48L2c+PC9zdmc+">
<style>
:root { --bg:#fafaf7; --fg:#1a1a1a; --muted:#7a7569; --rule:#e4e2dc;
  --accent:#b8541a; --code-bg:#f0ede4; --link:var(--accent); }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1a1a1a; --fg:#e8e6e0; --muted:#9a948a; --rule:#333;
    --accent:#e08a4a; --code-bg:#252525; }
}
* { box-sizing: border-box; }
body { font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  max-width:680px; margin:0 auto; padding:60px 24px 40px; color:var(--fg); background:var(--bg); }
h1 { font-size:2em; margin-bottom:.1em; }
h2 { font-size:1.2em; margin-top:1.8em; border-bottom:1px solid var(--rule); padding-bottom:.2em; }
.tag { color:var(--muted); margin-top:0; font-size:1.05em; }
a { color:var(--link); text-decoration:underline; text-decoration-color:color-mix(in srgb, var(--link) 40%, transparent); text-underline-offset:2px; }
a:hover { text-decoration-color:var(--link); }
code, pre { background:var(--code-bg); padding:.1em .35em; border-radius:3px; font-size:.9em; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { padding:12px 14px; overflow-x:auto; line-height:1.45; }
.lede { font-size:1.05em; }
hr { border:none; border-top:1px solid var(--rule); margin:3em 0 1.5em; }
footer { color:var(--muted); font-size:13px; text-align:center; }
footer a { color:var(--muted); }
@media (max-width:600px) { body { padding:32px 16px; } }
</style></head><body>
<h1>livespec</h1>
<p class="tag">Upload markdown · get a URL · collect per-block comments.</p>

<p class="lede">A tiny service for reviewing markdown documents — specs, plans, design notes — outside the chat window. POST a markdown file, get back a URL. Open it in a browser, hover any paragraph to leave a comment or tap ✓ to approve. Click <em>Copy all</em> to dump every comment back into the conversation.</p>

<p>Designed so an agent can drive the whole loop: upload a spec, share the URL with a human reviewer, fetch the comments, apply the edits, push a new version at the same URL. The reader's tab keeps working — comments persist across browsers and devices.</p>

<h2>Upload a doc</h2>
<pre>curl -X POST https://livespec.finereli.com --data @spec.md</pre>
<p>Returns <code>{ id, editToken, url }</code>. Save the <code>editToken</code> to update later.</p>

<h2>Update a doc</h2>
<pre>curl -X PUT https://livespec.finereli.com/&lt;id&gt; \\
  -H "x-edit-token: &lt;token&gt;" \\
  --data @spec.md</pre>

<h2>Read comments</h2>
<pre>curl https://livespec.finereli.com/api/docs/&lt;id&gt;/comments</pre>
<p>Returns a JSON array of <code>{ type, blockId, anchor, body, author, order }</code> — where <code>type</code> is <code>"comment"</code> or <code>"approve"</code>.</p>

<h2>Source</h2>
<p><a href="https://github.com/finereli/livespec">github.com/finereli/livespec</a> — single Cloudflare Worker, KV-backed, MIT-ish.</p>

<hr>
<footer>© <a href="https://finereli.com">Eli Finer</a></footer>
</body></html>`;
