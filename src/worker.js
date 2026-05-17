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

async function loadDoc(env, id) {
  const raw = await env.LIVESPEC.get("doc:" + id);
  return raw ? JSON.parse(raw) : null;
}
async function saveDoc(env, id, doc) {
  await env.LIVESPEC.put("doc:" + id, JSON.stringify(doc));
}
async function loadComments(env, id) {
  const raw = await env.LIVESPEC.get("comments:" + id);
  return raw ? JSON.parse(raw) : [];
}
async function saveComments(env, id, arr) {
  await env.LIVESPEC.put("comments:" + id, JSON.stringify(arr));
}

async function createDoc(req, url, env) {
  const md = await req.text();
  if (!md.trim()) return bad("empty markdown");
  const id = randId();
  const editToken = randToken();
  const now = Date.now();
  await saveDoc(env, id, {
    title: firstH1(md), markdown: md, editToken, created: now, updated: now,
  });
  const base = url.origin;
  return json({
    id, editToken,
    url: `${base}/${id}`,
    rawUrl: `${base}/api/docs/${id}`,
    commentsUrl: `${base}/api/docs/${id}/comments`,
  }, 201);
}

async function updateDoc(req, env, id) {
  const doc = await loadDoc(env, id);
  if (!doc) return notFound("doc not found");
  const token = req.headers.get("x-edit-token");
  if (token !== doc.editToken) return forbidden("invalid edit token");
  const md = await req.text();
  if (!md.trim()) return bad("empty markdown");
  doc.markdown = md;
  doc.title = firstH1(md);
  doc.updated = Date.now();
  await saveDoc(env, id, doc);
  return json({ id, title: doc.title, updated: doc.updated });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return json({}, 204);

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

    // --- API: doc routes /api/docs/:id[/comments[/:cid]] ---
    const apiMatch = pathname.match(/^\/api\/docs\/([a-z0-9]{4,})(?:\/(comments)(?:\/([a-z0-9]{4,}))?)?$/);
    if (apiMatch) {
      const [, id, sub, cid] = apiMatch;
      const doc = await loadDoc(env, id);
      if (!doc) return notFound("doc not found");

      // GET doc (raw json)
      if (!sub && req.method === "GET") {
        return json({
          id, title: doc.title, markdown: doc.markdown,
          created: doc.created, updated: doc.updated,
        });
      }
      // PUT doc (update markdown; requires edit token)
      if (!sub && req.method === "PUT") return updateDoc(req, env, id);
      // DELETE doc (requires edit token)
      if (!sub && req.method === "DELETE") {
        const token = req.headers.get("x-edit-token");
        if (token !== doc.editToken) return forbidden("invalid edit token");
        await env.LIVESPEC.delete("doc:" + id);
        await env.LIVESPEC.delete("comments:" + id);
        return json({ ok: true });
      }

      // Comments
      if (sub === "comments" && !cid && req.method === "GET") {
        return json(await loadComments(env, id));
      }
      if (sub === "comments" && !cid && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.blockId) return bad("blockId required");
        const author = body.author || "anon";
        const type = body.type === "approve" ? "approve" : "comment";
        const comments = await loadComments(env, id);
        if (type === "approve") {
          // Toggle: one approval per (blockId, author).
          const idx = comments.findIndex(
            (c) => c.type === "approve" && c.blockId === body.blockId && c.author === author,
          );
          if (idx >= 0) {
            comments.splice(idx, 1);
            await saveComments(env, id, comments);
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
          await saveComments(env, id, comments);
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
        await saveComments(env, id, comments);
        return json(entry, 201);
      }
      if (sub === "comments" && cid && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body || !body.body) return bad("body required");
        const author = body.author || req.headers.get("x-author");
        const editToken = req.headers.get("x-edit-token");
        const comments = await loadComments(env, id);
        const idx = comments.findIndex((c) => c.cid === cid);
        if (idx < 0) return notFound("comment not found");
        const c = comments[idx];
        if (c.type !== "comment") return bad("only comments can be edited");
        if (c.author !== author && editToken !== doc.editToken) return forbidden("not your comment");
        c.body = String(body.body).slice(0, 5000);
        c.updated = Date.now();
        await saveComments(env, id, comments);
        return json(c);
      }
      if (sub === "comments" && cid && req.method === "DELETE") {
        const author = req.headers.get("x-author") || url.searchParams.get("author");
        const editToken = req.headers.get("x-edit-token");
        const comments = await loadComments(env, id);
        const idx = comments.findIndex((c) => c.cid === cid);
        if (idx < 0) return notFound("comment not found");
        const c = comments[idx];
        if (c.author !== author && editToken !== doc.editToken) {
          return forbidden("not your comment");
        }
        comments.splice(idx, 1);
        await saveComments(env, id, comments);
        return json({ ok: true });
      }
    }

    // --- /:id — GET renders HTML; PUT updates markdown (edit token required). ---
    const docMatch = pathname.match(/^\/([a-z0-9]{4,})\/?$/);
    if (docMatch) {
      const id = docMatch[1];
      if (req.method === "PUT") return updateDoc(req, env, id);
      if (req.method === "GET") {
        const doc = await loadDoc(env, id);
        if (!doc) return new Response("Not found", { status: 404 });
        const html = renderHtml(id, doc);
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
function escapeScript(s) {
  // Prevent breaking out of <script type="text/markdown">
  return s.replace(/<\/script>/gi, "<\\/script>");
}

function renderHtml(id, doc) {
  const title = escapeHtml(doc.title || "Untitled");
  const md = escapeScript(doc.markdown);
  return TEMPLATE
    .replace(/__TITLE__/g, title)
    .replace(/__DOC_ID__/g, id)
    .replace("__MARKDOWN__", md);
}

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>__TITLE__ — livespec</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<style>
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
</style>
</head>
<body>
<div class="topbar">
  <a class="brand" href="/">livespec</a>
  <span class="count"><span id="approve-count">0</span> approved · <span id="count">0</span> <span id="count-label">comments</span></span>
  <button id="copy-all" class="primary">Copy all</button>
</div>
<main id="content"></main>
<footer class="doc-footer">__DOC_ID__</footer>
<div class="toast" id="toast"></div>
<script id="md-source" type="text/markdown">__MARKDOWN__<\/script>
<script>
(function () {
  const DOC_ID = "__DOC_ID__";
  const API = "/api/docs/" + DOC_ID + "/comments";

  let AUTHOR = localStorage.getItem("livespec:author");
  if (!AUTHOR) {
    AUTHOR = "u-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("livespec:author", AUTHOR);
  }

  const content = document.getElementById("content");
  const countEl = document.getElementById("count");
  const toast = document.getElementById("toast");

  const md = document.getElementById("md-source").textContent;
  const rendered = document.createElement("div");
  rendered.innerHTML = marked.parse(md);

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function showToast(msg, err) {
    toast.textContent = msg;
    toast.classList.toggle("err", !!err);
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 1800);
  }
  function snippet(el, n) {
    const t = el.textContent.replace(/\\s+/g, " ").trim();
    return t.length > (n || 200) ? t.slice(0, n || 200) + "…" : t;
  }

  const blockSelectors = "h1,h2,h3,h4,h5,h6,p,ul,ol,pre,blockquote,table";
  const sourceBlocks = [...rendered.querySelectorAll(":scope > " + blockSelectors)];
  const wraps = [];
  let order = 0;

  function buildBlock(contentEl, isTable, isList) {
    const idx = order++;
    const id = "b-" + idx + "-" + hash(contentEl.textContent.trim());
    const wrap = document.createElement("div");
    wrap.className = "block-wrap" + (isList ? " is-list" : "");
    wrap.dataset.blockId = id;
    wrap.dataset.order = idx;

    const blockText = document.createElement("div");
    blockText.className = "block-text" + (isTable ? " is-table" : "");

    const actions = document.createElement("div");
    actions.className = "block-actions";

    const addBtn = document.createElement("button");
    addBtn.className = "pill add";
    addBtn.type = "button";
    addBtn.textContent = "+ comment";
    addBtn.addEventListener("click", (e) => { e.stopPropagation(); openEditor(wrap, null); });

    const approveBtn = document.createElement("button");
    approveBtn.className = "pill approve";
    approveBtn.type = "button";
    approveBtn.title = "Approve this block";
    approveBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleApprove(wrap); });

    actions.appendChild(addBtn);
    actions.appendChild(approveBtn);

    if (isTable) {
      const tw = document.createElement("div");
      tw.className = "table-scroll";
      tw.appendChild(contentEl);
      blockText.appendChild(tw);
    } else {
      blockText.appendChild(contentEl);
    }
    blockText.appendChild(actions);

    const commentsEl = document.createElement("div");
    commentsEl.className = "block-comments";

    wrap.appendChild(blockText);
    wrap.appendChild(commentsEl);
    content.appendChild(wrap);
    wraps.push(wrap);
  }

  sourceBlocks.forEach((el) => {
    // Split lists so each <li> is its own commentable block. Re-wrap each item
    // in a fresh <ul>/<ol> to preserve bullets / numbering.
    if (el.tagName === "UL" || el.tagName === "OL") {
      const items = [...el.children].filter((c) => c.tagName === "LI");
      items.forEach((li, i) => {
        const listClone = document.createElement(el.tagName);
        if (el.tagName === "OL") listClone.setAttribute("start", String(i + 1));
        listClone.appendChild(li);
        buildBlock(listClone, false, true);
      });
    } else {
      buildBlock(el, el.tagName === "TABLE", false);
    }
  });
  const wrapById = Object.fromEntries(wraps.map((w) => [w.dataset.blockId, w]));

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
        const isMine = c.author === AUTHOR;
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
    const sorted = COMMENTS.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const cmts = sorted.filter((c) => (c.type || "comment") === "comment");
    const approvedBlocks = new Set(sorted.filter((c) => c.type === "approve").map((c) => c.blockId));
    if (!cmts.length && !approvedBlocks.size) { showToast("Nothing to copy"); return; }
    const out = ["# Review of: " + document.title.replace(/ — livespec$/, ""), ""];
    // Group comments by block, with approval marker.
    const byBlock = {};
    for (const c of cmts) (byBlock[c.blockId] = byBlock[c.blockId] || { anchor: c.anchor, order: c.order, items: [] }).items.push(c.body);
    // Add approved-only blocks (no comments) so they appear too.
    for (const c of sorted) {
      if (c.type === "approve" && !byBlock[c.blockId]) {
        byBlock[c.blockId] = { anchor: c.anchor, order: c.order, items: [] };
      }
    }
    const groups = Object.entries(byBlock).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
    for (const [blockId, g] of groups) {
      out.push("> " + g.anchor.split("\\n").join("\\n> "));
      out.push("");
      if (approvedBlocks.has(blockId)) out.push("✓ approved");
      for (const body of g.items) out.push(body);
      out.push("");
      out.push("---");
      out.push("");
    }
    try {
      await navigator.clipboard.writeText(out.join("\\n"));
      showToast("Copied " + groups.length + " block(s)");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = out.join("\\n"); document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove();
      showToast("Copied " + groups.length + " block(s)");
    }
  });

  refresh();
  setInterval(refresh, 30000);
})();
<\/script>
</body>
</html>`;

const LANDING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>livespec — review markdown documents</title>
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
