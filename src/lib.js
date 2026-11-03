// Shared plumbing: schema, crypto, sessions, agents, access codes, usage, model calls.

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const bad = (msg, code = "bad_request") => new HttpError(400, code, msg);
export const now = () => Date.now();
const DAY = 864e5;

// ---------- schema (created on first request; safe to run repeatedly) ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    description TEXT, instructions TEXT NOT NULL, greeting TEXT, notice TEXT, model TEXT NOT NULL,
    daily_limit INTEGER NOT NULL DEFAULT 100, status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS codes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code_hash TEXT UNIQUE NOT NULL,
    hint TEXT NOT NULL, label TEXT, daily_limit INTEGER, expires_at INTEGER, revoked_at INTEGER,
    created_at INTEGER NOT NULL, first_used_at INTEGER, last_used_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS codes_agent ON codes(agent_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT, code_id TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code_id TEXT,
    agent_version INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS conv_agent ON conversations(agent_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, code_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
    input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS msg_usage ON messages(agent_id, role, created_at)`,
  `CREATE TABLE IF NOT EXISTS deploy_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS attempts_key ON attempts(key, at)`,
];
let schemaReady = null;
export function ensureSchema(env) {
  schemaReady ??= env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
export const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results ?? [];
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

// ---------- crypto ----------
export async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(prefix = "", bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const uid = () => crypto.randomUUID();
export function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Access codes: 12 characters from a 32-letter alphabet with no look-alikes (no 0, 1, I, O), shown as XXXX-XXXX-XXXX.
const ALPHA = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(12));
  const s = [...r].map((b) => ALPHA[b % 32]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
export function normalizeCode(input) {
  const s = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 12 || [...s].some((c) => !ALPHA.includes(c))) return null;
  return s;
}

// ---------- throttling (failed sign-ins) ----------
export async function throttle(env, key, max, windowMs) {
  const r = await one(env, "SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND at > ?", key, now() - windowMs);
  if ((r?.n ?? 0) >= max) throw new HttpError(429, "slow_down", "Too many tries. Wait 15 minutes and try again.");
}
export async function recordFail(env, key) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO attempts (key, at) VALUES (?, ?)").bind(key, now()),
    env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(now() - DAY),
  ]);
}

// ---------- sessions ----------
export async function createSession(env, kind, ttlMs, agentId = null, codeId = null) {
  const token = randomToken("s_", 32);
  await run(env, "INSERT INTO sessions (token_hash, kind, agent_id, code_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    await sha256(token), kind, agentId, codeId, now(), now() + ttlMs);
  return token;
}
export async function endSession(env, token) {
  if (token) await run(env, "DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
}
export async function adminFromToken(env, token) {
  if (!token) return false;
  const s = await one(env, "SELECT expires_at FROM sessions WHERE token_hash = ? AND kind = 'admin'", await sha256(token));
  return !!s && s.expires_at > now();
}
// Returns the code row this browser signed in with for this agent, or null.
export async function codeFromToken(env, token, agentId) {
  if (!token) return null;
  const s = await one(env, `SELECT s.expires_at AS s_exp, c.* FROM sessions s JOIN codes c ON c.id = s.code_id
    WHERE s.token_hash = ? AND s.kind = 'user' AND s.agent_id = ?`, await sha256(token), agentId);
  if (!s || s.s_exp <= now() || s.revoked_at || (s.expires_at && s.expires_at <= now())) return null;
  return s;
}

// ---------- agents ----------
const RESERVED = new Set(["admin", "api", "mcp", "assets", "favicon-ico", "robots-txt"]);
export function slugify(s) {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
export function cleanPatch(input = {}) {
  const p = {};
  const str = (k, max) => { if (typeof input[k] === "string") p[k] = input[k].slice(0, max); };
  str("name", 80); str("description", 400); str("instructions", 100000); str("greeting", 1000); str("notice", 600);
  if (typeof input.model === "string" && /^claude-[a-z0-9.-]+$/.test(input.model)) p.model = input.model;
  const daily = input.daily_limit ?? input.daily_replies_per_user;
  if (Number.isInteger(daily)) p.daily_limit = Math.min(10000, Math.max(1, daily));
  if (input.status === "active" || input.status === "paused") p.status = input.status;
  return p;
}
export const agentBySlug = (env, slug) => one(env, "SELECT * FROM agents WHERE slug = ?", String(slug ?? ""));
export async function requireAgent(env, slug) {
  const a = await agentBySlug(env, slug);
  if (!a) throw new HttpError(404, "no_agent", `There's no agent at "${slug}".`);
  return a;
}
export const agentUrls = (origin, slug) => ({ url: `${origin}/${slug}`, admin_url: `${origin}/admin?a=${slug}` });
export function agentView(a) {
  return { slug: a.slug, name: a.name, description: a.description, greeting: a.greeting, notice: a.notice, model: a.model,
    daily_limit: a.daily_limit, status: a.status, version: a.version, updated_at: a.updated_at };
}

export async function deployAgent(env, origin, input) {
  const patch = cleanPatch(input);
  const slug = slugify(input.slug || input.name);
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) || RESERVED.has(slug)) throw bad("Pick a name or slug of 3–40 letters, numbers, or dashes.");
  const existing = await agentBySlug(env, slug);
  if (existing) {
    const keys = Object.keys(patch);
    const sets = [...keys.map((k) => `${k} = ?`), "version = version + 1", "updated_at = ?"].join(", ");
    await run(env, `UPDATE agents SET ${sets} WHERE id = ?`, ...keys.map((k) => patch[k]), now(), existing.id);
  } else {
    if (!patch.instructions?.trim()) throw bad("Instructions (the agent's system prompt) are required for a new agent.");
    await run(env, `INSERT INTO agents (id, slug, name, description, instructions, greeting, notice, model, daily_limit, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      uid(), slug, patch.name || slug, patch.description ?? null, patch.instructions, patch.greeting ?? null, patch.notice ?? null,
      patch.model || env.DEFAULT_MODEL || "claude-sonnet-5-5", patch.daily_limit ?? 100, patch.status ?? "active", now(), now());
  }
  const agent = await agentBySlug(env, slug);
  return { agent: agentView(agent), created: !existing, ...agentUrls(origin, slug) };
}

// ---------- access codes ----------
export async function createCode(env, origin, agent, { label, expires_days, daily_limit } = {}) {
  const code = newCode();
  const days = Number.isInteger(expires_days) && expires_days > 0 ? Math.min(expires_days, 3650) : null;
  const limit = Number.isInteger(daily_limit) && daily_limit > 0 ? Math.min(daily_limit, 10000) : null;
  const id = uid();
  await run(env, `INSERT INTO codes (id, agent_id, code_hash, hint, label, daily_limit, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, agent.id, await sha256(normalizeCode(code)), code.slice(-4), String(label ?? "").slice(0, 80) || null, limit,
    days ? now() + days * DAY : null, now());
  const { url } = agentUrls(origin, agent.slug);
  return { id, code, label: label || null, link: url, link_with_code: `${url}?code=${code}`, expires_at: days ? now() + days * DAY : null, daily_limit: limit };
}
export async function listCodes(env, agent) {
  return await all(env, `SELECT c.id, c.hint, c.label, c.daily_limit, c.expires_at, c.revoked_at, c.created_at, c.first_used_at, c.last_used_at,
      (SELECT COUNT(*) FROM messages m WHERE m.code_id = c.id AND m.role = 'assistant') AS replies
    FROM codes c WHERE c.agent_id = ? ORDER BY c.created_at DESC`, agent.id);
}
export async function revokeCode(env, agent, ref) {
  const r = String(ref ?? "").trim();
  const row = await one(env, `SELECT id, hint, label FROM codes WHERE agent_id = ? AND revoked_at IS NULL AND (id = ? OR hint = ? OR label = ?)`,
    agent.id, r, r.toUpperCase().slice(-4), r);
  if (!row) throw new HttpError(404, "no_code", "No active code matches that. Use the code's ID, its last 4 characters, or its label.");
  await env.DB.batch([
    env.DB.prepare("UPDATE codes SET revoked_at = ? WHERE id = ?").bind(now(), row.id),
    env.DB.prepare("DELETE FROM sessions WHERE code_id = ?").bind(row.id),
  ]);
  return { revoked: row.id, hint: row.hint, label: row.label };
}
export const statusOf = (c) => c.revoked_at ? "revoked" : c.expires_at && c.expires_at <= now() ? "expired" : c.first_used_at ? "active" : "unused";

// ---------- usage ----------
export async function repliesLast24h(env, agentId, codeId) {
  const r = await one(env, `SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND code_id IS ? AND role = 'assistant' AND created_at > ?`,
    agentId, codeId, now() - DAY);
  return r?.n ?? 0;
}
export async function usageSummary(env, agent, days = 30) {
  const since = now() - days * DAY;
  const rows = await all(env, `SELECT m.code_id, c.label, c.hint, COUNT(*) AS replies,
      COALESCE(SUM(m.input_tokens), 0) AS input_tokens, COALESCE(SUM(m.output_tokens), 0) AS output_tokens
    FROM messages m LEFT JOIN codes c ON c.id = m.code_id
    WHERE m.agent_id = ? AND m.role = 'assistant' AND m.created_at > ? GROUP BY m.code_id ORDER BY replies DESC`, agent.id, since);
  const t = rows.reduce((a, r) => ({ replies: a.replies + r.replies, input_tokens: a.input_tokens + r.input_tokens, output_tokens: a.output_tokens + r.output_tokens }),
    { replies: 0, input_tokens: 0, output_tokens: 0 });
  return { days, ...t, by_code: rows.map((r) => ({ who: r.code_id ? (r.label || "Code …" + r.hint) : "You (admin)", hint: r.hint ?? null,
    replies: r.replies, tokens: r.input_tokens + r.output_tokens })) };
}

// ---------- model ----------
export async function callClaude(env, model, system, messages) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "no_key", "The model key isn't set up yet. Add ANTHROPIC_API_KEY in Cloudflare.");
  const t0 = now();
  const r = await fetch((env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, system, messages }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("anthropic_error", r.status, JSON.stringify(j).slice(0, 400));
    if (r.status === 401) throw new HttpError(502, "bad_key", "The model key was rejected. Check ANTHROPIC_API_KEY in Cloudflare.");
    if (r.status === 404) throw new HttpError(502, "bad_model", "This agent's model isn't available. Pick another on the admin page.");
    if (r.status === 429 || r.status === 529) throw new HttpError(503, "busy", "The model is busy. Try again in a minute.");
    throw new HttpError(502, "upstream", "The model couldn't be reached. Try again.");
  }
  const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new HttpError(502, "empty", "The model returned an empty reply. Try again.");
  return { text, usage: j.usage ?? {}, latency: now() - t0, stop: j.stop_reason };
}
