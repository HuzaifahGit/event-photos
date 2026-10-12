// Guest site: static files + same-origin reads from R2, so the gallery works
// even when the Mac (selfie search / uploads) is offline.
// The Mac publishes photos.json; the Raspberry Pi publishes photos-pi.json
// (guest photos it took in while the Mac was offline). Merge them by id.
// Who is in which photo: the Mac publishes people.json, the Pi people-pi.json
// (people who searched while the Mac was off). Merged by name.
async function mergedPeople(env) {
  const byName = new Map();
  for (const k of ["people.json", "people-pi.json"]) {
    const o = await env.PHOTOS.get(k);
    if (!o) continue;
    try {
      for (const p of (await o.json()).people || []) {
        const cur = byName.get(p.name);
        if (!cur) byName.set(p.name, { ...p, photos: [...new Set(p.photos)] });
        else { cur.photos = [...new Set([...cur.photos, ...p.photos])]; cur.nick = cur.nick || p.nick;
               cur.us = [...new Set([...(cur.us || []), ...(p.us || [])])]; }
      }
    } catch {}
  }
  return new Response(JSON.stringify({ people: [...byName.values()] }),
    { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
}

async function mergedList(env) {
  const [mac, pi] = await Promise.all(["photos.json", "photos-pi.json"].map(async (k) => {
    const o = await env.PHOTOS.get(k);
    try { return o ? await o.json() : null; } catch { return null; }
  }));
  const seen = new Set(), photos = [];
  for (const list of [mac, pi]) for (const p of (list && list.photos) || []) {
    if (!seen.has(p.id)) { seen.add(p.id); photos.push(p); }
  }
  photos.sort((a, b) => (b.taken || "").localeCompare(a.taken || ""));
  return new Response(JSON.stringify({ updated: Date.now(), photos }), {
    headers: { "content-type": "application/json", "cache-control": "no-cache" },
  });
}

// ---------------- reactions + comments (D1), work with the Mac offline
const EMOJIS = ["❤️", "😂", "😮", "👏", "🔥"];
const PID = /^[a-z0-9]{12}$/;
const DEV = /^[A-Za-z0-9_-]{8,64}$/;
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// Public stand-in for a device id (same as the Mac's cloud.owner_hash).
async function ownerHash(device) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(device)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

// device -> owner hash, so a guest's reactions from earlier browsers (restored
// by name, sent as "us") count as theirs after a re-login
const OH = new Map();
async function oh(d) { let h = OH.get(d); if (!h) { h = await ownerHash(d); OH.set(d, h); } return h; }
function usSet(v, device) {
  const a = Array.isArray(v) ? v : String(v || "").split(",");
  return new Set(a.filter((x) => /^[0-9a-f]{10}$/.test(x)).slice(0, 50));
}
async function myDevices(rows, device, us) {   // rows: [{device}] -> devices that are this person
  const out = new Set();
  for (const x of rows) if (x.device === device || (us.size && us.has(await oh(x.device)))) out.add(x.device);
  return out;
}

async function social(request, env, url, ctx) {
  const db = env.SOCIAL;
  const path = url.pathname;
  // ---- saved profile per guest-list name, so a cleared browser can get its
  // nickname, picture, posts, notifications, selfie results and settings back
  if (path === "/api/social/profile" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const name = String(b.fullname || "").trim().slice(0, 80);
    const data = JSON.stringify(b.data || {});
    if (!DEV.test(b.device || "") || !name || data.length > 24000) return json({ error: "bad_request" }, 400);
    const u = await ownerHash(b.device);
    const row = await db.prepare("SELECT us FROM profiles WHERE fullname=?").bind(name).first();
    const us = [...new Set([...(row ? JSON.parse(row.us) : []), u])].slice(-12);
    await db.prepare("INSERT INTO profiles (fullname, us, data, updated) VALUES (?, ?, ?, ?) "
      + "ON CONFLICT(fullname) DO UPDATE SET us=excluded.us, data=excluded.data, updated=excluded.updated")
      .bind(name, JSON.stringify(us), data, Date.now()).run();
    return json({ ok: true });
  }
  if (path === "/api/social/profile/restore" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const name = String(b.fullname || "").trim().slice(0, 80);
    if (!DEV.test(b.device || "") || !name) return json({ error: "bad_request" }, 400);
    const row = await db.prepare("SELECT us, data FROM profiles WHERE fullname=?").bind(name).first();
    if (!row) return json({ found: false });
    const us = JSON.parse(row.us), u = await ownerHash(b.device);
    // carry the latest profile picture over to this browser
    const have = await db.prepare("SELECT v FROM avatars WHERE u=?").bind(u).first();
    if (!have) {
      for (const old of [...us].reverse()) {
        if (old === u) continue;
        const a = await db.prepare("SELECT v FROM avatars WHERE u=?").bind(old).first();
        const o = a && await env.PHOTOS.get(`avatars/${old}.jpg`);
        if (!o) continue;
        await env.PHOTOS.put(`avatars/${u}.jpg`, o.body, { httpMetadata: { contentType: "image/jpeg" } });
        await db.prepare("INSERT INTO avatars (u, v) VALUES (?, ?) ON CONFLICT(u) DO UPDATE SET v=excluded.v").bind(u, Date.now()).run();
        break;
      }
    }
    return json({ found: true, us: us.filter((x) => x !== u), data: JSON.parse(row.data || "{}") });
  }
  // ---- profile pictures: a small square JPEG per guest, stored in R2
  if (path === "/api/social/avatar" && request.method === "POST") {
    const device = url.searchParams.get("device") || "";
    if (!DEV.test(device)) return json({ error: "bad_request" }, 400);
    const body = await request.arrayBuffer();
    const b = new Uint8Array(body);
    if (body.byteLength > 400000 || b[0] !== 0xff || b[1] !== 0xd8) return json({ error: "bad_image" }, 400);
    const u = await ownerHash(device), v = Date.now();
    await env.PHOTOS.put(`avatars/${u}.jpg`, body, { httpMetadata: { contentType: "image/jpeg" } });
    await db.prepare("INSERT INTO avatars (u, v) VALUES (?, ?) ON CONFLICT(u) DO UPDATE SET v=excluded.v").bind(u, v).run();
    return json({ ok: true, u, v });
  }
  if (path === "/api/social/avatar" && request.method === "DELETE") {
    const device = url.searchParams.get("device") || "";
    if (!DEV.test(device)) return json({ error: "bad_request" }, 400);
    const u = await ownerHash(device);
    await env.PHOTOS.delete(`avatars/${u}.jpg`);
    await db.prepare("DELETE FROM avatars WHERE u=?").bind(u).run();
    return json({ ok: true });
  }
  // ---- notifications: likes and comments by others on my photos
  if (path === "/api/social/activity" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).filter((x) => PID.test(x)))].slice(0, 400);
    if (!DEV.test(b.device || "") || !ids.length) return json({ items: [] });
    // D1 allows at most 100 bound values per query: look up in chunks
    const r = { results: [] }, c = { results: [] };
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90), q = part.map(() => "?").join(",");
      const [rr, cc] = await Promise.all([
        db.prepare(`SELECT photo_id, emoji, name, device, created_at FROM reactions WHERE photo_id IN (${q}) AND device != ? ORDER BY created_at DESC LIMIT 60`).bind(...part, b.device).all(),
        db.prepare(`SELECT photo_id, body, name, device, created_at FROM comments WHERE photo_id IN (${q}) AND device != ? ORDER BY created_at DESC LIMIT 60`).bind(...part, b.device).all(),
      ]);
      r.results.push(...rr.results); c.results.push(...cc.results);
    }
    const items = [];
    for (const x of r.results) items.push({ type: "like", photo: x.photo_id, emoji: x.emoji, name: x.name || "Guest", u: await ownerHash(x.device), at: x.created_at });
    for (const x of c.results) items.push({ type: "comment", photo: x.photo_id, body: x.body, name: x.name || "Guest", u: await ownerHash(x.device), at: x.created_at });
    items.sort((a, b2) => b2.at - a.at);
    return json({ items: items.slice(0, 80) });
  }
  if (path === "/api/social/summary" && request.method === "GET") {
    const device = url.searchParams.get("device") || "";
    const [r, c, mine, first, caps, av] = await Promise.all([
      db.prepare("SELECT photo_id, emoji, COUNT(*) n FROM reactions GROUP BY photo_id, emoji").all(),
      db.prepare("SELECT photo_id, COUNT(*) n FROM comments GROUP BY photo_id").all(),
      DEV.test(device) ? db.prepare("SELECT photo_id, emoji, device FROM reactions").all()
                       : Promise.resolve({ results: [] }),
      // the first comment on each photo, shown under the photo without opening comments
      db.prepare("SELECT c.photo_id, c.name, c.body FROM comments c JOIN "
        + "(SELECT photo_id, MIN(id) mid FROM comments GROUP BY photo_id) f ON c.id = f.mid").all(),
      db.prepare("SELECT photo_id, name, body, device FROM captions").all(),
      db.prepare("SELECT u, v FROM avatars").all(),
    ]);
    const reactions = {}, comments = {}, my = {}, firstComment = {}, captions = {};
    for (const x of r.results) (reactions[x.photo_id] ||= {})[x.emoji] = x.n;
    for (const x of c.results) comments[x.photo_id] = x.n;
    const us = usSet(url.searchParams.get("us"), device);
    const meDev = await myDevices([...new Set(mine.results.map((x) => x.device))].map((d) => ({ device: d })), device, us);
    for (const x of mine.results) if (meDev.has(x.device)) {
      const l = (my[x.photo_id] ||= []); if (!l.includes(x.emoji)) l.push(x.emoji);
    }
    for (const x of first.results) firstComment[x.photo_id] = { name: x.name || "Guest", body: x.body };
    for (const x of caps.results) captions[x.photo_id] = { name: x.name || "Guest", body: x.body, mine: x.device === device };
    const avatars = Object.fromEntries(av.results.map((x) => [x.u, x.v]));
    return json({ emojis: EMOJIS, reactions, comments, mine: my, firstComment, captions, avatars });
  }
  if (path === "/api/social/react" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!PID.test(b.photo_id || "") || !DEV.test(b.device || "") || !EMOJIS.includes(b.emoji)) return json({ error: "bad_request" }, 400);
    // the same person on an earlier browser counts as already reacted
    // One reaction per person per photo: a new emoji replaces their old one(s),
    // on whichever of their browsers it was made.
    const ex = await db.prepare("SELECT device FROM reactions WHERE photo_id=?").bind(b.photo_id).all();
    const meDev = await myDevices(ex.results, b.device, usSet(b.us, b.device));
    if (b.on && meDev.size) await db.batch([...meDev].map((d) =>
      db.prepare("DELETE FROM reactions WHERE photo_id=? AND device=?").bind(b.photo_id, d)));
    if (b.on) await db.prepare("INSERT INTO reactions (photo_id, device, emoji, created_at, name) VALUES (?,?,?,?,?)"
      + " ON CONFLICT(photo_id, device, emoji) DO UPDATE SET name=excluded.name")
      .bind(b.photo_id, b.device, b.emoji, Date.now(), clean(b.name, 40) || null).run();
    else if (!b.on && meDev.size) await db.batch([...meDev].map((d) =>
      db.prepare("DELETE FROM reactions WHERE photo_id=? AND device=? AND emoji=?").bind(b.photo_id, d, b.emoji)));
    const counts = await db.prepare("SELECT emoji, COUNT(*) n FROM reactions WHERE photo_id=? GROUP BY emoji").bind(b.photo_id).all();
    return json({ counts: Object.fromEntries(counts.results.map((x) => [x.emoji, x.n])) });
  }
  // Caption on a guest photo. The uploader's phone computes the photo ID (same
  // hash the indexer uses) and posts the caption right after the upload, so it
  // works whether the Mac or the Pi takes the photo. Only that phone can edit it.
  if (path === "/api/social/caption" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!/^g[0-9a-f]{11}$/.test(b.photo_id || "") || !DEV.test(b.device || "")) return json({ error: "bad_request" }, 400);
    const body = clean(b.caption, 150);
    const cur = await db.prepare("SELECT device FROM captions WHERE photo_id=?").bind(b.photo_id).first();
    if (cur && cur.device !== b.device) return json({ error: "not_yours" }, 403);
    if (!body) await db.prepare("DELETE FROM captions WHERE photo_id=? AND device=?").bind(b.photo_id, b.device).run();
    else await db.prepare("INSERT INTO captions (photo_id, device, name, body, created_at) VALUES (?,?,?,?,?)"
      + " ON CONFLICT(photo_id) DO UPDATE SET body=excluded.body, name=excluded.name")
      .bind(b.photo_id, b.device, clean(b.name, 40) || null, body, Date.now()).run();
    return json({ ok: true, caption: body });
  }
  if (path === "/api/social/reactors" && request.method === "GET") {   // who reacted
    const pid = url.searchParams.get("photo_id") || "";
    if (!PID.test(pid)) return json({ error: "bad_request" }, 400);
    const rows = await db.prepare("SELECT emoji, name FROM reactions WHERE photo_id=? ORDER BY created_at DESC LIMIT 200").bind(pid).all();
    return json({ reactors: rows.results.map((x) => ({ emoji: x.emoji, name: x.name || "Guest" })) });
  }
  if (path === "/api/social/comments" && request.method === "GET") {
    const pid = url.searchParams.get("photo_id") || "";
    if (!PID.test(pid)) return json({ error: "bad_request" }, 400);
    const rows = await db.prepare("SELECT id, name, body, created_at, device FROM comments WHERE photo_id=? ORDER BY created_at LIMIT 300").bind(pid).all();
    const device = url.searchParams.get("device") || "";
    // likes on these comments: count + whether this phone liked each one
    const likes = new Map();
    if (rows.results.length) {
      const lr = await db.prepare("SELECT l.comment_id id, COUNT(*) n, SUM(l.device = ?) me FROM comment_likes l JOIN comments c ON c.id = l.comment_id"
        + " WHERE c.photo_id = ? GROUP BY l.comment_id").bind(device, pid).all();
      for (const x of lr.results) likes.set(x.id, x);
    }
    const out = [];
    for (const x of rows.results) {
      const l = likes.get(x.id);
      out.push({ id: x.id, name: x.name, body: x.body, at: x.created_at, mine: x.device === device, u: await ownerHash(x.device),
                 likes: l ? l.n : 0, liked: !!(l && l.me) });
    }
    return json({ comments: out });
  }
  if (path === "/api/social/comments" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const body = clean(b.body, 200), name = clean(b.name, 40);
    if (!PID.test(b.photo_id || "") || !DEV.test(b.device || "") || !body) return json({ error: "bad_request" }, 400);
    // simple flood guard: 20 comments per phone per 10 minutes
    const recent = await db.prepare("SELECT COUNT(*) n FROM comments WHERE device=? AND created_at > ?").bind(b.device, Date.now() - 600000).first();
    if (recent.n >= 20) return json({ error: "slow_down" }, 429);
    const at = Date.now();
    const res = await db.prepare("INSERT INTO comments (photo_id, device, name, body, created_at) VALUES (?,?,?,?,?)")
      .bind(b.photo_id, b.device, name || null, body, at).run();
    return json({ comment: { id: res.meta.last_row_id, name: name || null, body, at, mine: true } });
  }
  if (/^\/api\/social\/comments\/\d+\/like$/.test(path) && request.method === "POST") {   // like / unlike a comment
    const id = Number(path.split("/")[4]);
    const b = await request.json().catch(() => ({}));
    if (!DEV.test(b.device || "")) return json({ error: "bad_request" }, 400);
    const have = await db.prepare("SELECT 1 FROM comment_likes WHERE comment_id=? AND device=?").bind(id, b.device).first();
    if (have) await db.prepare("DELETE FROM comment_likes WHERE comment_id=? AND device=?").bind(id, b.device).run();
    else {
      const c = await db.prepare("SELECT 1 FROM comments WHERE id=?").bind(id).first();
      if (!c) return json({ error: "not_found" }, 404);
      await db.prepare("INSERT OR IGNORE INTO comment_likes (comment_id, device, created_at) VALUES (?,?,?)").bind(id, b.device, Date.now()).run();
    }
    const n = await db.prepare("SELECT COUNT(*) n FROM comment_likes WHERE comment_id=?").bind(id).first();
    return json({ ok: true, liked: !have, likes: n.n });
  }
  if (path.startsWith("/api/social/comments/") && request.method === "DELETE") {   // delete your own
    const id = Number(path.split("/").pop());
    const device = url.searchParams.get("device") || "";
    const r = await env.SOCIAL.prepare("DELETE FROM comments WHERE id=? AND device=?").bind(id, device).run();
    if (r.meta.changes) await env.SOCIAL.prepare("DELETE FROM comment_likes WHERE comment_id=?").bind(id).run();
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}

// ---------------- QR-code gate
// The QR link is /?code=XXXXXX. A correct code earns a signed pass cookie
// (60 days); without it every path shows the "scan the QR code" page.
// The same pass, as a token, unlocks selfie search and uploads on the Mac/Pi.
const PASS_DAYS = 60;
const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
async function makePass(env) {
  const exp = Math.floor(Date.now() / 1000) + PASS_DAYS * 86400;
  return `v1.${exp}.${await hmac(env.GATE_SECRET, `v1.${exp}`)}`;
}
async function validPass(env, token) {
  const m = /^v1\.(\d+)\.([0-9a-f]{40})$/.exec(token || "");
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  const want = await hmac(env.GATE_SECRET, `v1.${m[1]}`);
  return want.length === m[2].length && [...want].every((c, i) => c === m[2][i]);
}
const cookie = (req, name) => (req.headers.get("cookie") || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];
const codeOk = (env, code) => {
  const want = String(env.EVENT_CODE || "").toUpperCase();
  const got = String(code || "").trim().toUpperCase();
  return want && got.length === want.length && [...want].every((c, i) => c === got[i]);
};
const issuingOpen = (env) => !env.ISSUE_UNTIL || Date.now() < Date.parse(env.ISSUE_UNTIL);

function gatePage(msg = "") {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0e0f12">
<title>Event · Guests only</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
background:#0b0a12;color:#f4f4f6;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;position:relative;overflow:hidden}
body::before{content:"";position:fixed;inset:0;background:url(/static/brand/tile.png) 0 0/250px auto repeat;opacity:.5}
@media (min-width:700px){body::before{background-size:300px auto}}
body::after{content:"";position:fixed;inset:0;background:radial-gradient(90% 60% at 50% 50%,rgba(11,10,18,.55),rgba(11,10,18,.92))}
.card{position:relative;z-index:1}
.card{width:100%;max-width:380px;text-align:center}.mark{font-size:28px;background:linear-gradient(100deg,#3f7bff,#8b5cf6,#e06fd0);-webkit-background-clip:text;background-clip:text;color:transparent}
h1{font-size:26px;margin:10px 0 8px;letter-spacing:-.02em}p{color:#9a9fab;margin:0 0 22px;line-height:1.45}
input{width:100%;min-height:52px;border-radius:14px;border:1px solid #2a2e36;background:#20232a;color:#f4f4f6;
font-size:22px;letter-spacing:.2em;text-align:center;text-transform:uppercase;font-family:ui-monospace,Menlo,monospace}
input:focus{outline:2px solid #8b5cf6}button{width:100%;min-height:52px;margin-top:10px;border:0;border-radius:999px;
background:linear-gradient(100deg,#3f7bff,#8b5cf6,#e06fd0);color:#fff;font-size:17px;font-weight:700}.err{color:#ff8a8a;min-height:20px;margin:10px 0 0;font-size:14px}
</style></head><body><form class="card" method="post" action="/gate">
<div class="mark">◆</div><h1>Guests only</h1>
<p>This photo gallery is for guests at the Event. Scan the QR code on your table, or enter the event code printed under it.</p>
<input name="code" maxlength="12" autocomplete="off" autocapitalize="characters" placeholder="CODE" required>
<button type="submit">Enter</button><p class="err">${msg}</p></form></body></html>`;
  return new Response(html, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function grantPass(pass, to = "/", vid = null) {
  const h = new Headers({ location: to, "cache-control": "no-store" });
  h.append("set-cookie", `event_pass=${pass}; Path=/; Max-Age=${PASS_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  if (vid) h.append("set-cookie", `event_vid=${vid}; Path=/; Max-Age=${PASS_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 303, headers: h });
}

const newVid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

async function gate(request, env, url, ctx) {
  if (!env.GATE_SECRET) return null;                        // gate off
  const vid = cookie(request, "event_vid");
  if (url.pathname.startsWith("/static/brand/")) return null;  // backdrop shows on the gate page too
  // 1) QR link: /?code=XXXX
  const qr = url.searchParams.get("code");
  if (qr !== null) {
    if (codeOk(env, qr) && issuingOpen(env)) {
      const v = vid || newVid();
      return grantPass(await makePass(env), "/", vid ? null : v);
    }
    if (!(await validPass(env, cookie(request, "event_pass"))))
      return gatePage(issuingOpen(env) ? "That link's code isn't right." : "New sign-ins have closed for this event.");
  }
  // 2) code typed on the gate page
  if (url.pathname === "/gate" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    await new Promise((r) => setTimeout(r, 400));             // slow down guessing
    if (form && codeOk(env, form.get("code")) && issuingOpen(env)) {
      const v = vid || newVid();
      return grantPass(await makePass(env), "/", vid ? null : v);
    }
    return gatePage(issuingOpen(env) ? "That code isn't right. Check the card on your table." : "New sign-ins have closed for this event.");
  }
  // 3) everything else needs a valid pass
  if (await validPass(env, cookie(request, "event_pass"))) {
    if (url.pathname === "/pass") {                            // token for selfie search / uploads
      return new Response(JSON.stringify({ token: cookie(request, "event_pass") }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return null;                                              // allowed
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/r2/") || url.pathname === "/photos.json" || url.pathname === "/people.json" || url.pathname === "/programs.json" || url.pathname.startsWith("/avatar/") || url.pathname === "/pass")
    return new Response(JSON.stringify({ error: "guests_only" }), { status: 401, headers: { "content-type": "application/json" } });
  return gatePage();
}

// Guest videos (up to 100 MB): the raw file body is streamed straight into R2
// (never held in memory); details come in the query string.
const MAX_VIDEO = 100 * 1024 * 1024;
async function videoUpload(request, env, url) {
  const len = Number(request.headers.get("content-length") || 0);
  if (!len) return json({ detail: "no_file" }, 400);
  if (len > MAX_VIDEO) return json({ detail: "too_large" }, 413);
  const q = url.searchParams;
  const uploader = String(q.get("uploader") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (uploader.length < 8) return json({ detail: "bad_uploader" }, 400);
  const ext = { mp4: "mp4", m4v: "mp4", mov: "mov", webm: "webm", "3gp": "mp4" }[String(q.get("ext") || "").toLowerCase()];
  if (!ext || !/^video\//.test(request.headers.get("content-type") || "")) return json({ detail: "bad_video" }, 400);
  const db = env.SOCIAL;
  const row = await db.prepare("SELECT n FROM guest_uploads WHERE device=?").bind(uploader).first();
  const done = row ? row.n : 0;
  if (done >= MAX_PER_GUEST) return json({ detail: "limit_reached" }, 429);
  const taken = String(q.get("taken") || ""), batch = String(q.get("batch") || "");
  const side = {
    uploader_id: uploader,
    name: String(q.get("name") || "").split(/\s+/).join(" ").trim().slice(0, 40) || null,
    taken: /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(taken) ? taken : null,
    kind: "video", mirror: false,
    batch: /^[a-z0-9]{6,24}$/.test(batch) ? batch : null,
  };
  const rnd = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const stem = `${uploader.slice(0, 12)}_${Date.now()}_${rnd}`;
  await env.PHOTOS.put(`incoming/${stem}.${ext}`, request.body, { httpMetadata: { contentType: request.headers.get("content-type") } });
  await env.PHOTOS.put(`incoming/${stem}.json`, JSON.stringify(side), { httpMetadata: { contentType: "application/json" } });
  await db.prepare("INSERT INTO guest_uploads (device, n) VALUES (?, 1) ON CONFLICT(device) DO UPDATE SET n = n + 1").bind(uploader).run();
  return json({ ok: true, remaining: MAX_PER_GUEST - done - 1 });
}

// Guest uploads go straight into R2 (incoming/), untouched. The Mac (or the Pi as
// backup) pulls them from there, runs face recognition and adds them to the album,
// so a guest's upload never waits on the home internet link or the Mac being on.
const MAX_UPLOAD = 25 * 1024 * 1024, MAX_PER_GUEST = 40;
async function directUpload(request, env) {
  const form = await request.formData().catch(() => null);
  const file = form && form.get("photo");
  if (!file || typeof file === "string") return json({ detail: "no_file" }, 400);
  if (file.size > MAX_UPLOAD) return json({ detail: "too_large" }, 413);
  const uploader = String(form.get("uploader") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (uploader.length < 8) return json({ detail: "bad_uploader" }, 400);
  const kind = form.get("kind") === "boomerang" ? "boomerang" : "photo";
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ftyp = String.fromCharCode(...head.slice(4, 12));
  let ext = null;
  if (kind === "boomerang") {
    if (ftyp.startsWith("ftyp")) ext = "mp4";
    else if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) ext = "webm";
  } else if ((head[0] === 0xff && head[1] === 0xd8) || (head[0] === 0x89 && head[1] === 0x50) || /^ftyp(heic|heix|mif1|msf1|avif)/.test(ftyp))
    ext = "jpg";            // same as the old upload path: the indexer reads it by content
  if (!ext) return json({ detail: kind === "boomerang" ? "bad_video" : "bad_image" }, 400);
  // per-guest limit
  const db = env.SOCIAL;
  const row = await db.prepare("SELECT n FROM guest_uploads WHERE device=?").bind(uploader).first();
  const done = row ? row.n : 0;
  if (done >= MAX_PER_GUEST) return json({ detail: "limit_reached" }, 429);  
  const taken = String(form.get("taken") || "");
  const batch = String(form.get("batch") || "");
  const side = {
    uploader_id: uploader,
    name: String(form.get("name") || "").split(/\s+/).join(" ").trim().slice(0, 40) || null,
    taken: /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(taken) ? taken : null,
    kind, mirror: form.get("mirror") === "1",
    batch: /^[a-z0-9]{6,24}$/.test(batch) ? batch : null,
  };
  const rnd = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const stem = `${uploader.slice(0, 12)}_${Date.now()}_${rnd}`;
  await env.PHOTOS.put(`incoming/${stem}.${ext}`, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  await env.PHOTOS.put(`incoming/${stem}.json`, JSON.stringify(side), { httpMetadata: { contentType: "application/json" } });  // written last = ready
  await db.prepare("INSERT INTO guest_uploads (device, n) VALUES (?, 1) ON CONFLICT(device) DO UPDATE SET n = n + 1").bind(uploader).run();
  return json({ ok: true, remaining: MAX_PER_GUEST - done - 1 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const blocked = await gate(request, env, url, ctx);
    if (blocked) return blocked;
    if (url.pathname === "/api/upload-direct" && request.method === "POST") return directUpload(request, env);
    if (url.pathname === "/api/upload-video" && request.method === "POST") return videoUpload(request, env, url);
    if (url.pathname.startsWith("/api/social/")) return social(request, env, url, ctx);
    if (url.pathname === "/photos.json") return mergedList(env);
    if (url.pathname === "/people.json") return mergedPeople(env);
    const av = url.pathname.match(/^\/avatar\/([0-9a-f]{10})\.jpg$/);
    if (av) {
      const o = await env.PHOTOS.get(`avatars/${av[1]}.jpg`);
      if (!o) return new Response("not found", { status: 404 });
      return new Response(o.body, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
    }
    if (url.pathname === "/programs.json") {      // optional programme tabs, uploaded to R2
      const o = await env.PHOTOS.get(url.pathname.slice(1));
      return new Response(o ? o.body : (url.pathname === "/programs.json" ? '{"programs":[]}' : '{"names":[]}'),
        { headers: { "content-type": "application/json", "cache-control": `public, max-age=${url.pathname === "/programs.json" ? 20 : 60}` } });
    }
    let key = null;
    if (url.pathname.startsWith("/r2/")) key = url.pathname.slice(4);
    if (key !== null) {
      const isVideo = /^(video|vthumb)\/[a-z0-9]{12}\.mp4$/.test(key);
      if (!isVideo && !/^(thumb|mid|web|full)\/[a-z0-9]{12}\.jpg$/.test(key)) return new Response("not found", { status: 404 });
      // Videos must answer byte-range requests, or iPhones won't play them.
      const range = isVideo ? request.headers.get("range") : null;
      const obj = await env.PHOTOS.get(key, range ? { range: request.headers } : {});
      if (!obj) return new Response("not found", { status: 404 });
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set("etag", obj.httpEtag);
      h.set("cache-control", "public, max-age=86400");
      if (isVideo) {
        h.set("accept-ranges", "bytes");
        h.set("content-type", "video/mp4");
        if (range && obj.range) {
          const r = obj.range;
          const suf = r.suffix != null ? Math.min(r.suffix, obj.size) : null;
          const start = suf != null ? obj.size - suf : (r.offset ?? 0);
          const len = suf != null ? suf : (r.length ?? (obj.size - start));
          h.set("content-range", `bytes ${start}-${start + len - 1}/${obj.size}`);
          h.set("content-length", String(len));
          return new Response(obj.body, { status: 206, headers: h });
        }
        h.set("content-length", String(obj.size));
      }
      return new Response(obj.body, { headers: h });
    }
    return env.ASSETS.fetch(request);
  },
};
