// KarmanLang Worker. One address serves:
//   /<slug>        chat page for an agent (sign in with an access code)
//   /admin         owner console (sign in with ADMIN_PASSWORD)
//   /api           JSON API for both pages  ({ action, ... }, POST)
//   /mcp/<token>   connector for Claude, ChatGPT and the karman CLI
import {
  HttpError, bad, now, ensureSchema, one, all, run, sha256, sameString, normalizeCode, throttle, recordFail,
  createSession, endSession, adminFromToken, codeFromToken, requireAgent, agentUrls, agentView, deployAgent,
  createCode, listCodes, revokeCode, statusOf, repliesLast24h, usageSummary, callClaude, uid, randomToken,
} from "./lib.js";
import { handleMcp } from "./mcp.js";

const DAY = 864e5, MAX_MSG = 8000, HISTORY_KEEP = 30, MAX_CONV_REPLIES = 150;
const ADMIN_COOKIE = "kl_admin", userCookie = (slug) => `kl_u_${slug}`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/api") return api(req, env, url);
    if (p === "/mcp" || p.startsWith("/mcp/")) { await ensureSchema(env); return handleMcp(req, env, url); }
    if (p.startsWith("/assets/") || p === "/favicon.ico" || p === "/robots.txt") return env.ASSETS.fetch(req);
    const page = p === "/admin" || p === "/admin/" ? "/admin" : "/";
    const res = await env.ASSETS.fetch(new Request(new URL(page, url), { headers: req.headers }));
    const h = new Headers(res.headers);
    h.set("cache-control", "no-cache"); h.set("x-frame-options", "DENY"); h.set("referrer-policy", "same-origin");
    return new Response(res.body, { status: 200, headers: h });
  },
};

// ---------- request plumbing ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const cookie = (name, value, maxAgeSec) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;

async function api(req, env, url) {
  const setCookies = [];
  const reply = (o, status = 200) => {
    const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    for (const c of setCookies) h.append("set-cookie", c);
    return new Response(JSON.stringify(o), { status, headers: h });
  };
  try {
    if (req.method !== "POST") throw new HttpError(405, "method", "POST only.");
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "origin", "Requests must come from this site.");
    if (!(req.headers.get("content-type") || "").includes("application/json")) throw bad("Send JSON.");
    await ensureSchema(env);
    const body = await req.json().catch(() => ({}));
    const c = { env, req, url, origin: url.origin, body, cookies: parseCookies(req), setCookies,
      ip: req.headers.get("cf-connecting-ip") || "local" };
    const fn = ACTIONS[body?.action];
    if (!fn) throw bad("Unknown action.", "action");
    return reply(await fn(c));
  } catch (e) {
    if (e instanceof HttpError) return reply({ error: e.code, message: e.message }, e.status);
    console.error("karman_error", e?.stack || e);
    return reply({ error: "server", message: "Something went wrong on the server. Try again." }, 500);
  }
}

const isAdmin = (c) => adminFromToken(c.env, c.cookies[ADMIN_COOKIE]);
async function requireAdmin(c) {
  if (!(await isAdmin(c))) throw new HttpError(401, "signin", "Sign in on the admin page first.");
}
// Who is using this agent: the admin, or a person with a valid code. Throws if neither.
async function accessFor(c, agent) {
  if (await isAdmin(c)) return { admin: true, code: null };
  const code = await codeFromToken(c.env, c.cookies[userCookie(agent.slug)], agent.id);
  if (!code) throw new HttpError(401, "code", "Enter your access code.");
  if (agent.status !== "active") throw new HttpError(403, "paused", "This agent is paused by its owner.");
  return { admin: false, code };
}
const limitFor = (agent, who) => who.admin ? null : (who.code.daily_limit ?? agent.daily_limit);
async function remaining(env, agent, who) {
  const limit = limitFor(agent, who);
  if (limit == null) return null;
  return Math.max(0, limit - (await repliesLast24h(env, agent.id, who.code.id)));
}

// ---------- actions ----------
const ACTIONS = {
  // People using an agent
  async agent_public(c) {
    const a = await requireAgent(c.env, c.body.slug);
    let signedIn = false, admin = false;
    try { const w = await accessFor(c, a); signedIn = true; admin = w.admin; } catch {}
    return { slug: a.slug, name: a.name, description: a.description, notice: a.notice, status: a.status, signedIn, admin };
  },
  async redeem(c) {
    const a = await requireAgent(c.env, c.body.slug);
    const key = "code:" + c.ip;
    await throttle(c.env, key, 20, 15 * 60e3);
    const norm = normalizeCode(c.body.code);
    const row = norm && await one(c.env, "SELECT * FROM codes WHERE code_hash = ? AND agent_id = ?", await sha256(norm), a.id);
    if (!row) { await recordFail(c.env, key); throw new HttpError(401, "bad_code", "That code isn't valid for this agent. Check it and try again."); }
    if (row.revoked_at) throw new HttpError(403, "revoked", "This code has been turned off. Ask the owner for a new one.");
    if (row.expires_at && row.expires_at <= now()) throw new HttpError(403, "expired", "This code has expired. Ask the owner for a new one.");
    if (a.status !== "active") throw new HttpError(403, "paused", "This agent is paused by its owner.");
    const ttl = Math.min(90 * DAY, row.expires_at ? row.expires_at - now() : 90 * DAY);
    const token = await createSession(c.env, "user", ttl, a.id, row.id);
    await run(c.env, "UPDATE codes SET first_used_at = COALESCE(first_used_at, ?), last_used_at = ? WHERE id = ?", now(), now(), row.id);
    c.setCookies.push(cookie(userCookie(a.slug), token, ttl / 1000));
    return { ok: true };
  },
  async signout(c) {
    const a = await requireAgent(c.env, c.body.slug);
    await endSession(c.env, c.cookies[userCookie(a.slug)]);
    c.setCookies.push(cookie(userCookie(a.slug), "", 0));
    return { ok: true };
  },
  async start(c) {
    const a = await requireAgent(c.env, c.body.slug);
    const who = await accessFor(c, a);
    const id = uid();
    await run(c.env, "INSERT INTO conversations (id, agent_id, code_id, agent_version, created_at) VALUES (?, ?, ?, ?, ?)",
      id, a.id, who.code?.id ?? null, a.version, now());
    return { conversationId: id, greeting: a.greeting || `Hi! I'm ${a.name}. How can I help?`,
      agent: { name: a.name, notice: a.notice, description: a.description }, admin: who.admin,
      remainingToday: await remaining(c.env, a, who) };
  },
  async chat(c) {
    const a = await requireAgent(c.env, c.body.slug);
    const who = await accessFor(c, a);
    const cid = String(c.body.conversationId ?? "");
    const conv = await one(c.env, "SELECT * FROM conversations WHERE id = ? AND agent_id = ? AND code_id IS ?", cid, a.id, who.code?.id ?? null);
    if (!conv) throw new HttpError(404, "no_conversation", "This conversation isn't available. Start a new one.");
    const msg = String(c.body.message ?? "").trim();
    if (!msg) throw bad("Type a message first.");
    if (msg.length > MAX_MSG) throw bad(`Keep messages under ${MAX_MSG} characters.`);
    if ((await remaining(c.env, a, who)) === 0) throw new HttpError(429, "daily_limit", "You've reached today's limit for this agent. It resets over the next 24 hours.");
    const hist = await all(c.env, "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id", cid);
    if (hist.filter((m) => m.role === "assistant").length >= MAX_CONV_REPLIES) throw new HttpError(429, "conversation_full", "This conversation is at its length limit. Start a new one.");
    let ctx = [];
    for (let i = 0; i < hist.length; i++) {
      if (hist[i].role === "user" && hist[i + 1]?.role === "assistant") { ctx.push(hist[i], hist[i + 1]); i++; }
    }
    ctx = ctx.slice(-HISTORY_KEEP).map((m) => ({ role: m.role, content: m.content }));
    ctx.push({ role: "user", content: msg });
    await run(c.env, "INSERT INTO messages (conversation_id, agent_id, code_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
      cid, a.id, who.code?.id ?? null, msg, now());
    const out = await callClaude(c.env, a.model, a.instructions, ctx);
    await run(c.env, `INSERT INTO messages (conversation_id, agent_id, code_id, role, content, input_tokens, output_tokens, latency_ms, created_at)
      VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`, cid, a.id, who.code?.id ?? null, out.text,
      out.usage.input_tokens ?? null, out.usage.output_tokens ?? null, out.latency, now());
    if (who.code) await run(c.env, "UPDATE codes SET last_used_at = ? WHERE id = ?", now(), who.code.id);
    return { reply: out.text, truncated: out.stop === "max_tokens", remainingToday: await remaining(c.env, a, who) };
  },

  // Owner
  async admin_login(c) {
    if (!c.env.ADMIN_PASSWORD) throw new HttpError(503, "no_password", "ADMIN_PASSWORD isn't set yet. Add it in Cloudflare → this Worker → Settings → Variables and Secrets.");
    const key = "login:" + c.ip;
    await throttle(c.env, key, 10, 15 * 60e3);
    const ok = sameString(await sha256(String(c.body.password ?? "")), await sha256(c.env.ADMIN_PASSWORD));
    if (!ok) { await recordFail(c.env, key); throw new HttpError(401, "bad_password", "Wrong password."); }
    const token = await createSession(c.env, "admin", 30 * DAY);
    c.setCookies.push(cookie(ADMIN_COOKIE, token, 30 * DAY / 1000));
    return { ok: true };
  },
  async admin_logout(c) {
    await endSession(c.env, c.cookies[ADMIN_COOKIE]);
    c.setCookies.push(cookie(ADMIN_COOKIE, "", 0));
    return { ok: true };
  },
  async admin_me(c) { return { admin: await isAdmin(c), origin: c.origin, connector_base: `${c.origin}/mcp` }; },
  async agents(c) {
    await requireAdmin(c);
    const rows = await all(c.env, `SELECT a.*, (SELECT COUNT(*) FROM codes k WHERE k.agent_id = a.id AND k.revoked_at IS NULL) AS codes
      FROM agents a ORDER BY a.updated_at DESC`);
    return { agents: rows.map((a) => ({ ...agentView(a), codes: a.codes, ...agentUrls(c.origin, a.slug) })) };
  },
  async agent(c) {
    await requireAdmin(c);
    const a = await requireAgent(c.env, c.body.slug);
    return { agent: { ...agentView(a), instructions: a.instructions }, ...agentUrls(c.origin, a.slug) };
  },
  async save_agent(c) { await requireAdmin(c); return deployAgent(c.env, c.origin, c.body.agent ?? {}); },
  async delete_agent(c) {
    await requireAdmin(c);
    const a = await requireAgent(c.env, c.body.slug);
    if (c.body.confirm !== a.slug) throw bad("Type the agent's slug to confirm.");
    await c.env.DB.batch(["messages", "conversations", "codes", "sessions"].map((t) => c.env.DB.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).bind(a.id))
      .concat(c.env.DB.prepare("DELETE FROM agents WHERE id = ?").bind(a.id)));
    return { deleted: a.slug };
  },
  async codes(c) {
    await requireAdmin(c);
    const a = await requireAgent(c.env, c.body.slug);
    return { codes: (await listCodes(c.env, a)).map((k) => ({ ...k, status: statusOf(k) })) };
  },
  async create_code(c) {
    await requireAdmin(c);
    const a = await requireAgent(c.env, c.body.slug);
    return createCode(c.env, c.origin, a, c.body);
  },
  async revoke_code(c) {
    await requireAdmin(c);
    const a = await requireAgent(c.env, c.body.slug);
    return revokeCode(c.env, a, c.body.id);
  },
  async usage(c) {
    await requireAdmin(c);
    const a = await requireAgent(c.env, c.body.slug);
    const d = Number.isInteger(c.body.days) ? Math.min(365, Math.max(1, c.body.days)) : 30;
    return usageSummary(c.env, a, d);
  },
  async conversations(c) {
    await requireAdmin(c);
    const a = await requireAgent(c.env, c.body.slug);
    if (c.body.id) {
      return { messages: await all(c.env, "SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND agent_id = ? ORDER BY id", c.body.id, a.id) };
    }
    const rows = await all(c.env, `SELECT v.id, v.created_at, v.agent_version, k.label, k.hint, v.code_id,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = v.id AND m.role = 'assistant') AS replies
      FROM conversations v LEFT JOIN codes k ON k.id = v.code_id WHERE v.agent_id = ? ORDER BY v.created_at DESC LIMIT 100`, a.id);
    return { conversations: rows.filter((r) => r.replies > 0).map((r) => ({ id: r.id, created_at: r.created_at, version: r.agent_version, replies: r.replies,
      who: r.code_id ? (r.label || "Code …" + r.hint) : "You (admin)" })) };
  },
  async tokens(c) {
    await requireAdmin(c);
    if (c.body.op === "create") {
      const token = randomToken("kl_");
      const name = String(c.body.name || "Connector").slice(0, 60);
      await run(c.env, "INSERT INTO deploy_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)", uid(), name, await sha256(token), now());
      return { token, connector_url: `${c.origin}/mcp/${token}`, endpoint: `${c.origin}/mcp` };
    }
    if (c.body.op === "revoke") await run(c.env, "UPDATE deploy_tokens SET revoked_at = ? WHERE id = ?", now(), String(c.body.id ?? ""));
    return { tokens: await all(c.env, "SELECT id, name, created_at, last_used_at, revoked_at FROM deploy_tokens ORDER BY created_at DESC") };
  },
};
