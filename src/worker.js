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
    .replace("__DOC_ID__", id)
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
    --panel-bg: #f3f1ea; --code-bg: #f0ede4;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1a1a1a; --fg: #e8e6e0; --muted: #999; --rule: #333;
      --accent: #e08a4a; --accent-bg: #2a1d12; --panel-bg: #222; --code-bg: #252525; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: grid; grid-template-columns: 1fr 380px; min-height: 100vh; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 32px 120px; width: 100%; }
  aside { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
    background: var(--panel-bg); border-left: 1px solid var(--rule); padding: 16px; font-size: 13px; }
  aside header { display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--rule); }
  aside h2 { font-size: 12px; margin: 0; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  aside .actions { display: flex; gap: 6px; }
  button { font: inherit; font-size: 12px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--rule); border-radius: 4px; padding: 4px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.primary:hover { opacity: .9; color: white; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 .5em; }
  h1 { font-size: 2em; border-bottom: 1px solid var(--rule); padding-bottom: .3em; }
  h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
  p { margin: .8em 0; }
  code { background: var(--code-bg); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
  pre { background: var(--code-bg); padding: 14px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid var(--accent); margin: 1em 0; padding: .3em 1em; color: var(--muted); }
  ul, ol { padding-left: 1.6em; }
  table { border-collapse: collapse; } th, td { border: 1px solid var(--rule); padding: 6px 10px; }
  .block { position: relative; }
  .block:hover { background: rgba(184, 84, 26, .04); }
  .block.has-comment { border-left: 3px solid var(--accent); padding-left: 12px; margin-left: -15px; }
  .block-btn { position: absolute; left: -36px; top: 4px; width: 26px; height: 26px; padding: 0;
    border-radius: 50%; opacity: 0; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .block:hover .block-btn, .block.has-comment .block-btn { opacity: 1; }
  .block.has-comment .block-btn { background: var(--accent); color: white; border-color: var(--accent); }
  .editor { margin: 8px 0; padding: 10px; background: var(--accent-bg);
    border: 1px solid var(--accent); border-radius: 6px; }
  .editor textarea { width: 100%; min-height: 70px; font: inherit; font-size: 14px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--rule);
    border-radius: 4px; padding: 8px; resize: vertical; }
  .editor .row { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; align-items: center; }
  .editor .status { font-size: 12px; color: var(--muted); margin-right: auto; }
  .comment-item { background: var(--bg); border: 1px solid var(--rule);
    border-radius: 6px; padding: 10px; margin-bottom: 8px; cursor: pointer; }
  .comment-item:hover { border-color: var(--accent); }
  .comment-item.mine { border-left: 3px solid var(--accent); }
  .comment-item .anchor { color: var(--muted); font-size: 11px; font-style: italic;
    margin-bottom: 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .comment-item .body { white-space: pre-wrap; }
  .comment-item .meta { font-size: 11px; color: var(--muted); margin-top: 6px; display: flex; justify-content: space-between; }
  .comment-item .del { font-size: 11px; padding: 2px 6px; }
  .empty { color: var(--muted); font-style: italic; padding: 20px 4px; text-align: center; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--fg); color: var(--bg); padding: 8px 16px; border-radius: 4px;
    font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }
  .toast.err { background: #c53030; color: white; }
  .doc-header { display: flex; justify-content: space-between; align-items: center;
    font-size: 12px; color: var(--muted); margin-bottom: -32px; }
  .doc-header a { color: var(--muted); }
  @media (max-width: 900px) {
    body { grid-template-columns: 1fr; }
    aside { position: static; height: auto; border-left: none; border-top: 1px solid var(--rule); }
    .block-btn { left: auto; right: 4px; }
  }
</style>
</head>
<body>
<main id="content">
  <div class="doc-header">
    <span>livespec · <a href="/">home</a></span>
    <span>id: __DOC_ID__</span>
  </div>
</main>
<aside>
  <header>
    <h2>Comments (<span id="count">0</span>)</h2>
    <div class="actions">
      <button id="refresh" title="Refresh">↻</button>
      <button id="copy-all" class="primary">Copy all</button>
    </div>
  </header>
  <div id="panel"></div>
</aside>
<div class="toast" id="toast"></div>
<script id="md-source" type="text/markdown">__MARKDOWN__<\/script>
<script>
(function () {
  const DOC_ID = "__DOC_ID__";
  const API = "/api/docs/" + DOC_ID + "/comments";

  // Stable per-browser author id (so a user can edit/delete their own).
  let AUTHOR = localStorage.getItem("livespec:author");
  if (!AUTHOR) {
    AUTHOR = "u-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("livespec:author", AUTHOR);
  }

  const content = document.getElementById("content");
  const panel = document.getElementById("panel");
  const countEl = document.getElementById("count");
  const toast = document.getElementById("toast");

  const md = document.getElementById("md-source").textContent;
  const renderedDiv = document.createElement("div");
  renderedDiv.id = "rendered";
  renderedDiv.innerHTML = marked.parse(md);
  content.appendChild(renderedDiv);

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
  const blocks = [...renderedDiv.querySelectorAll(":scope > " + blockSelectors)];
  blocks.forEach((el, idx) => {
    const text = el.textContent.trim();
    const id = "b-" + idx + "-" + hash(text);
    el.dataset.blockId = id;
    el.classList.add("block");
    const btn = document.createElement("button");
    btn.className = "block-btn";
    btn.title = "Add comment";
    btn.textContent = "💬";
    btn.onclick = (e) => { e.stopPropagation(); openEditor(el); };
    el.appendChild(btn);
  });
  const blockEls = Object.fromEntries(blocks.map((el) => [el.dataset.blockId, el]));

  let COMMENTS = [];

  async function refresh() {
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      COMMENTS = await res.json();
      renderPanel();
    } catch (e) {
      showToast("Failed to load comments", true);
    }
  }

  function openEditor(el) {
    if (el.nextSibling && el.nextSibling.classList && el.nextSibling.classList.contains("editor")) {
      el.nextSibling.querySelector("textarea").focus();
      return;
    }
    const mine = COMMENTS.find((c) => c.blockId === el.dataset.blockId && c.author === AUTHOR);
    const editor = document.createElement("div");
    editor.className = "editor";
    editor.innerHTML =
      '<textarea placeholder="Comment on this block…"></textarea>' +
      '<div class="row"><span class="status"></span>' +
      '<button class="cancel">Cancel</button>' +
      '<button class="primary save">Save</button></div>';
    const ta = editor.querySelector("textarea");
    const status = editor.querySelector(".status");
    ta.value = mine ? mine.body : "";
    editor.querySelector(".cancel").onclick = () => editor.remove();
    editor.querySelector(".save").onclick = async () => {
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
              blockId: el.dataset.blockId,
              anchor: snippet(el),
              body: text,
              author: AUTHOR,
              order: blocks.indexOf(el),
            }),
          });
        }
        editor.remove();
        await refresh();
      } catch (e) {
        status.textContent = "";
        showToast("Save failed", true);
      }
    };
    el.after(editor);
    ta.focus();
    ta.selectionStart = ta.value.length;
  }

  function renderPanel() {
    const sorted = COMMENTS.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.created - b.created);
    countEl.textContent = sorted.length;
    for (const el of blocks) el.classList.remove("has-comment");
    for (const c of sorted) {
      const el = blockEls[c.blockId];
      if (el) el.classList.add("has-comment");
    }
    if (!sorted.length) {
      panel.innerHTML = '<div class="empty">No comments yet.<br>Hover a block and click 💬</div>';
      return;
    }
    panel.innerHTML = "";
    for (const c of sorted) {
      const div = document.createElement("div");
      div.className = "comment-item" + (c.author === AUTHOR ? " mine" : "");
      const isMine = c.author === AUTHOR;
      div.innerHTML =
        '<div class="anchor"></div>' +
        '<div class="body"></div>' +
        '<div class="meta"><span class="who"></span>' +
        (isMine ? '<button class="del">delete</button>' : "<span></span>") +
        '</div>';
      div.querySelector(".anchor").textContent = "“" + c.anchor + "”";
      div.querySelector(".body").textContent = c.body;
      div.querySelector(".who").textContent = isMine ? "you" : c.author;
      div.onclick = () => {
        const el = blockEls[c.blockId];
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); if (isMine) openEditor(el); }
      };
      if (isMine) {
        div.querySelector(".del").onclick = async (e) => {
          e.stopPropagation();
          await fetch(API + "/" + c.cid + "?author=" + AUTHOR, { method: "DELETE" });
          await refresh();
        };
      }
      panel.appendChild(div);
    }
  }

  document.getElementById("refresh").onclick = refresh;
  document.getElementById("copy-all").onclick = async () => {
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
  };

  refresh();
  // Poll every 30s so collaborators' comments show up.
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
