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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return json({}, 204);

    // Landing
    if (pathname === "/" || pathname === "") {
      return new Response(LANDING_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // --- API: create doc ---
    if (pathname === "/api/docs" && req.method === "POST") {
      const md = await req.text();
      if (!md.trim()) return bad("empty markdown");
      const id = randId();
      const editToken = randToken();
      const now = Date.now();
      await saveDoc(env, id, {
        title: firstH1(md),
        markdown: md,
        editToken,
        created: now,
        updated: now,
      });
      const base = url.origin;
      return json({
        id,
        editToken,
        url: `${base}/${id}`,
        rawUrl: `${base}/api/docs/${id}`,
        commentsUrl: `${base}/api/docs/${id}/comments`,
      }, 201);
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
      if (!sub && req.method === "PUT") {
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
        if (!body || !body.blockId || !body.body) return bad("blockId and body required");
        const comments = await loadComments(env, id);
        // Upsert by (blockId, author)
        const author = body.author || "anon";
        const existing = comments.findIndex(
          (c) => c.blockId === body.blockId && c.author === author,
        );
        const entry = {
          cid: existing >= 0 ? comments[existing].cid : randId(10),
          blockId: body.blockId,
          anchor: (body.anchor || "").slice(0, 500),
          body: String(body.body).slice(0, 5000),
          author,
          order: typeof body.order === "number" ? body.order : 0,
          created: existing >= 0 ? comments[existing].created : Date.now(),
          updated: Date.now(),
        };
        if (existing >= 0) comments[existing] = entry;
        else comments.push(entry);
        await saveComments(env, id, comments);
        return json(entry, 201);
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

    // --- HTML: render doc ---
    const docMatch = pathname.match(/^\/([a-z0-9]{4,})\/?$/);
    if (docMatch && req.method === "GET") {
      const id = docMatch[1];
      const doc = await loadDoc(env, id);
      if (!doc) return new Response("Not found", { status: 404 });
      const html = renderHtml(id, doc);
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
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
    --bg: #fafaf7; --fg: #1a1a1a; --muted: #6b6b6b;
    --rule: #e4e2dc; --accent: #b8541a; --accent-bg: #fdf1e7;
    --code-bg: #f0ede4;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1a1a1a; --fg: #e8e6e0; --muted: #999; --rule: #333;
      --accent: #e08a4a; --accent-bg: #2a1d12; --code-bg: #252525; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }

  .topbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 20px; gap: 10px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(6px);
    border-bottom: 1px solid var(--rule);
    font-size: 13px;
  }
  .topbar .left { color: var(--muted); }
  .topbar .left a { color: var(--muted); }
  .topbar .right { display: flex; gap: 6px; align-items: center; }
  .topbar .count { color: var(--muted); margin-right: 4px; }

  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 120px; }

  button { font: inherit; font-size: 12px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--rule); border-radius: 4px; padding: 4px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.primary:hover { opacity: .9; color: white; }

  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 .4em; }
  h1 { font-size: 2em; border-bottom: 1px solid var(--rule); padding-bottom: .3em; }
  h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
  p { margin: .8em 0; }
  code { background: var(--code-bg); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
  pre { background: var(--code-bg); padding: 14px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid var(--accent); margin: 1em 0; padding: .3em 1em; color: var(--muted); }
  ul, ol { padding-left: 1.6em; }
  table { border-collapse: collapse; } th, td { border: 1px solid var(--rule); padding: 6px 10px; }

  .block-wrap { position: relative; margin: 0 -10px; padding: 0 10px; border-radius: 6px; transition: background .15s; }
  .block-wrap > :first-child { margin-top: .4em; }
  @media (hover: hover) {
    .block-wrap:hover { background: var(--accent-bg); }
  }
  .block-wrap.selected { background: var(--accent-bg); }
  .block-wrap.has-comment { box-shadow: inset 3px 0 0 var(--accent); }

  .add-btn {
    position: absolute; right: 6px; top: 4px;
    font-size: 11px; padding: 2px 10px;
    background: var(--accent); color: white;
    border: none; border-radius: 10px;
    opacity: 0; pointer-events: none;
    transition: opacity .15s;
  }
  @media (hover: hover) {
    .block-wrap:hover .add-btn { opacity: .9; pointer-events: auto; }
  }
  .block-wrap.selected .add-btn { opacity: 1; pointer-events: auto; }
  .add-btn:hover { opacity: 1 !important; color: white; }

  .block-comments { margin: 4px 0 12px; }
  .inline-comment {
    font-size: 13px; font-style: italic; color: var(--muted);
    border-left: 2px solid var(--accent);
    padding: 4px 10px; margin: 4px 0;
    background: color-mix(in srgb, var(--accent-bg) 60%, transparent);
    border-radius: 0 4px 4px 0;
    display: flex; gap: 8px; align-items: flex-start;
  }
  .inline-comment .body { flex: 1; white-space: pre-wrap; }
  .inline-comment .who { font-style: normal; font-size: 11px; opacity: .7; flex-shrink: 0; }
  .inline-comment.mine { cursor: pointer; }
  .inline-comment.mine:hover { background: var(--accent-bg); color: var(--fg); }
  .inline-comment .del {
    font-style: normal; font-size: 11px; padding: 0 6px; opacity: 0;
    background: transparent; border: none; color: var(--muted);
  }
  .inline-comment.mine:hover .del { opacity: 1; }
  .inline-comment .del:hover { color: var(--accent); }

  .editor { margin: 6px 0 12px; padding: 10px; background: var(--accent-bg);
    border: 1px solid var(--accent); border-radius: 6px; }
  .editor textarea { width: 100%; min-height: 70px; font: inherit; font-size: 14px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--rule);
    border-radius: 4px; padding: 8px; resize: vertical; }
  .editor .row { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; align-items: center; }
  .editor .status { font-size: 12px; color: var(--muted); margin-right: auto; }

  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--fg); color: var(--bg); padding: 8px 16px; border-radius: 4px;
    font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }
  .toast.err { background: #c53030; color: white; }

  @media (max-width: 600px) {
    main { padding: 20px 14px 100px; }
    body { font-size: 15px; }
    h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.1em; }
    .add-btn { right: 4px; top: 2px; padding: 3px 12px; font-size: 12px; }
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="left">livespec · <a href="/">home</a> · <span>__DOC_ID__</span></div>
  <div class="right">
    <span class="count"><span id="count">0</span> comment(s)</span>
    <button id="refresh" title="Refresh">↻</button>
    <button id="copy-all" class="primary">Copy all</button>
  </div>
</div>
<main id="content"></main>
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

  const TOUCH = matchMedia("(hover: none)").matches;

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

  // Wrap each top-level block in a .block-wrap with an add button and a comments container.
  const blockSelectors = "h1,h2,h3,h4,h5,h6,p,ul,ol,pre,blockquote,table";
  const sourceBlocks = [...rendered.querySelectorAll(":scope > " + blockSelectors)];
  const wraps = [];
  sourceBlocks.forEach((el, idx) => {
    const id = "b-" + idx + "-" + hash(el.textContent.trim());
    const wrap = document.createElement("div");
    wrap.className = "block-wrap";
    wrap.dataset.blockId = id;
    wrap.dataset.order = idx;
    const btn = document.createElement("button");
    btn.className = "add-btn";
    btn.type = "button";
    btn.textContent = "+ comment";
    btn.addEventListener("click", (e) => { e.stopPropagation(); openEditor(wrap); });
    const commentsEl = document.createElement("div");
    commentsEl.className = "block-comments";
    wrap.appendChild(el);
    wrap.appendChild(btn);
    wrap.appendChild(commentsEl);
    content.appendChild(wrap);
    wraps.push(wrap);
  });
  const wrapById = Object.fromEntries(wraps.map((w) => [w.dataset.blockId, w]));

  // Selection (mainly for touch; harmless on desktop).
  let selected = null;
  function select(wrap) {
    if (selected && selected !== wrap) selected.classList.remove("selected");
    selected = wrap;
    if (wrap) wrap.classList.add("selected");
  }
  document.addEventListener("click", (e) => {
    const wrap = e.target.closest(".block-wrap");
    // Ignore clicks on the editor / add-btn / inline comments — their handlers take care of state.
    if (e.target.closest(".editor, .add-btn, .inline-comment")) return;
    if (wrap) {
      // Don't steal text selection.
      if (window.getSelection && !window.getSelection().isCollapsed) return;
      select(wrap);
    } else {
      select(null);
    }
  });

  let COMMENTS = [];

  async function refresh() {
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      COMMENTS = await res.json();
      renderComments();
    } catch (e) {
      showToast("Failed to load comments", true);
    }
  }

  function openEditor(wrap) {
    const existing = wrap.querySelector(":scope > .editor");
    if (existing) { existing.querySelector("textarea").focus(); return; }
    const mine = COMMENTS.find((c) => c.blockId === wrap.dataset.blockId && c.author === AUTHOR);
    const editor = document.createElement("div");
    editor.className = "editor";
    editor.innerHTML =
      '<textarea placeholder="Comment on this block…"></textarea>' +
      '<div class="row"><span class="status"></span>' +
      '<button class="cancel" type="button">Cancel</button>' +
      '<button class="primary save" type="button">Save</button></div>';
    const ta = editor.querySelector("textarea");
    const status = editor.querySelector(".status");
    ta.value = mine ? mine.body : "";
    editor.querySelector(".cancel").addEventListener("click", (e) => {
      e.stopPropagation(); editor.remove();
    });
    editor.querySelector(".save").addEventListener("click", async (e) => {
      e.stopPropagation();
      const text = ta.value.trim();
      status.textContent = "Saving…";
      try {
        if (!text && mine) {
          await fetch(API + "/" + mine.cid + "?author=" + AUTHOR, { method: "DELETE" });
        } else if (text) {
          await fetch(API, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
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
    // Insert before the comments container (i.e. last child) — so editor sits between block and existing comments.
    wrap.insertBefore(editor, wrap.querySelector(":scope > .block-comments"));
    ta.focus();
    ta.selectionStart = ta.value.length;
  }

  function renderComments() {
    const sorted = COMMENTS.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.created - b.created);
    countEl.textContent = sorted.length;
    const byBlock = {};
    for (const c of sorted) (byBlock[c.blockId] = byBlock[c.blockId] || []).push(c);
    for (const wrap of wraps) {
      const list = byBlock[wrap.dataset.blockId] || [];
      wrap.classList.toggle("has-comment", list.length > 0);
      const container = wrap.querySelector(":scope > .block-comments");
      container.innerHTML = "";
      for (const c of list) {
        const div = document.createElement("div");
        const isMine = c.author === AUTHOR;
        div.className = "inline-comment" + (isMine ? " mine" : "");
        div.innerHTML =
          '<span class="body"></span>' +
          '<span class="who"></span>' +
          (isMine ? '<button class="del" type="button" title="Delete">×</button>' : "");
        div.querySelector(".body").textContent = c.body;
        div.querySelector(".who").textContent = isMine ? "you" : c.author;
        if (isMine) {
          div.addEventListener("click", (e) => {
            if (e.target.classList.contains("del")) return;
            openEditor(wrap);
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

  document.getElementById("refresh").addEventListener("click", refresh);
  document.getElementById("copy-all").addEventListener("click", async () => {
    if (!COMMENTS.length) { showToast("No comments to copy"); return; }
    const sorted = COMMENTS.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const out = ["# Comments on: " + document.title.replace(/ — livespec$/, ""), ""];
    for (const c of sorted) {
      out.push("> " + c.anchor.split("\\n").join("\\n> "));
      out.push("");
      out.push(c.body + (c.author === AUTHOR ? "" : "  \\n_— " + c.author + "_"));
      out.push("");
      out.push("---");
      out.push("");
    }
    try {
      await navigator.clipboard.writeText(out.join("\\n"));
      showToast("Copied " + sorted.length + " comment(s)");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = out.join("\\n"); document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove();
      showToast("Copied " + sorted.length + " comment(s)");
    }
  });

  refresh();
  setInterval(refresh, 30000);
})();
<\/script>
</body>
</html>`;

const LANDING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>livespec</title>
<style>
body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#1a1a1a;background:#fafaf7}
h1{font-size:2em;margin-bottom:.2em}
.tag{color:#6b6b6b;margin-top:0}
code,pre{background:#f0ede4;padding:.1em .35em;border-radius:3px;font-size:.9em}
pre{padding:14px;overflow-x:auto}
@media (prefers-color-scheme: dark){body{background:#1a1a1a;color:#e8e6e0}code,pre{background:#252525}}
</style></head><body>
<h1>livespec</h1>
<p class="tag">Upload markdown · get a URL · collect per-block comments.</p>

<h2>Upload a doc</h2>
<pre>curl -X POST https://livespec.finereli.com/api/docs \\
  --data-binary @spec.md</pre>
<p>Returns <code>{ id, editToken, url }</code>. Save the <code>editToken</code> to update later.</p>

<h2>Update a doc</h2>
<pre>curl -X PUT https://livespec.finereli.com/api/docs/&lt;id&gt; \\
  -H "x-edit-token: &lt;token&gt;" \\
  --data-binary @spec.md</pre>

<h2>Get comments</h2>
<pre>curl https://livespec.finereli.com/api/docs/&lt;id&gt;/comments</pre>
</body></html>`;
