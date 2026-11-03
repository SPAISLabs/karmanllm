// KarmanLang connector: a remote MCP server (Streamable HTTP, JSON responses).
// Add it in Claude or ChatGPT as a custom connector with the URL from /admin → Connect (…/mcp/<token>),
// or send "Authorization: Bearer <token>" to /mcp.
import {
  HttpError, bad, now, one, all, run, sha256, requireAgent, agentUrls, agentView, deployAgent, cleanPatch,
  createCode, listCodes, revokeCode, statusOf, usageSummary,
} from "./lib.js";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "karmanlang", title: "KarmanLang", version: "0.2.0" };
const INSTRUCTIONS = `KarmanLang turns an agent into a private web app. People get in with an access code.
Typical flow: deploy_agent (name + the agent's full instructions), then create_code once per person.
Give the person the link and the code (or link_with_code, which signs them in on open).
When the user says "deploy this agent" from inside a project or custom assistant, pass that assistant's full instructions as "instructions".`;

const str = (d) => ({ type: "string", description: d });
const int = (d) => ({ type: "integer", description: d });
const AGENT_PROPS = {
  name: str("Display name, e.g. 'NQRY Tutor'."),
  slug: str("Web address part, e.g. 'nqry' gives …/nqry. Defaults from the name. Reusing an existing slug updates that agent."),
  instructions: str("The agent's full system prompt. Required for a new agent."),
  description: str("One line shown on the sign-in page."),
  greeting: str("First message people see."),
  notice: str("Banner shown on every page, e.g. 'Educators only. Not for student use.'"),
  model: str("Claude model id. Default claude-sonnet-5-5."),
  daily_limit: int("Max agent replies per code per 24 h. Default 100."),
};
const SLUG = { slug: str("Agent slug.") };
const TOOLS = [
  { name: "list_agents", title: "List agents", description: "List deployed agents with their links.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "deploy_agent", title: "Deploy agent", description: "Create an agent's web app, or update it if the slug exists. Returns the link and admin link.",
    inputSchema: { type: "object", properties: AGENT_PROPS, required: ["name"] } },
  { name: "update_agent", title: "Update agent", description: "Change an existing agent's instructions or settings, or pause/resume it. Each change makes a new version.",
    inputSchema: { type: "object", properties: { ...AGENT_PROPS, status: { type: "string", enum: ["active", "paused"] } }, required: ["slug"] } },
  { name: "describe_agent", title: "Describe agent", description: "Show an agent's settings, links and access codes.",
    inputSchema: { type: "object", properties: SLUG, required: ["slug"] }, annotations: { readOnlyHint: true } },
  { name: "create_code", title: "Create access code", description: "Make an access code for one person. Returns the code, the link, and a link that signs them in directly.",
    inputSchema: { type: "object", properties: { ...SLUG, label: str("Who it's for, e.g. 'Ana – Lincoln HS'."),
      expires_days: int("Optional: days until the code stops working."), daily_limit: int("Optional: replies per 24 h for this code.") }, required: ["slug"] } },
  { name: "list_codes", title: "List access codes", description: "Access codes for an agent: label, last 4 characters, status, use.",
    inputSchema: { type: "object", properties: SLUG, required: ["slug"] }, annotations: { readOnlyHint: true } },
  { name: "revoke_code", title: "Turn off a code", description: "Turn off an access code and sign out anyone using it.",
    inputSchema: { type: "object", properties: { ...SLUG, code: str("The code's ID, its last 4 characters, or its label.") }, required: ["slug", "code"] },
    annotations: { destructiveHint: true } },
  { name: "get_usage", title: "Usage", description: "Replies and tokens for an agent, per code.",
    inputSchema: { type: "object", properties: { ...SLUG, days: int("Look-back window in days. Default 30.") }, required: ["slug"] }, annotations: { readOnlyHint: true } },
];

async function runTool(env, origin, name, args = {}) {
  switch (name) {
    case "list_agents": {
      const rows = await all(env, "SELECT * FROM agents ORDER BY updated_at DESC");
      return { agents: rows.map((a) => ({ ...agentView(a), ...agentUrls(origin, a.slug) })) };
    }
    case "deploy_agent": return deployAgent(env, origin, args);
    case "update_agent": {
      const a = await requireAgent(env, args.slug);
      return deployAgent(env, origin, { ...cleanPatch(args), slug: a.slug });
    }
    case "describe_agent": {
      const a = await requireAgent(env, args.slug);
      const codes = (await listCodes(env, a)).map((k) => ({ id: k.id, label: k.label, last4: k.hint, status: statusOf(k), replies: k.replies }));
      return { ...agentView(a), instructions_preview: String(a.instructions).slice(0, 600), ...agentUrls(origin, a.slug), codes };
    }
    case "create_code": return createCode(env, origin, await requireAgent(env, args.slug), args);
    case "list_codes": {
      const a = await requireAgent(env, args.slug);
      return { codes: (await listCodes(env, a)).map((k) => ({ id: k.id, label: k.label, last4: k.hint, status: statusOf(k), replies: k.replies, last_used_at: k.last_used_at })) };
    }
    case "revoke_code": return revokeCode(env, await requireAgent(env, args.slug), args.code);
    case "get_usage": {
      const a = await requireAgent(env, args.slug);
      return usageSummary(env, a, Number.isInteger(args.days) ? Math.min(365, Math.max(1, args.days)) : 30);
    }
  }
  throw bad(`Unknown tool ${name}.`, "unknown_tool");
}

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleMcp(req, env, url) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (req.method === "GET") return new Response("KarmanLang MCP endpoint. Use POST.", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response(null, { status: 405 });

  const pathToken = url.pathname.split("/")[2] || "";
  const auth = req.headers.get("authorization") ?? "";
  const token = pathToken || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
  const row = token.startsWith("kl_") && await one(env, "SELECT id, revoked_at FROM deploy_tokens WHERE token_hash = ?", await sha256(token));
  if (!row || row.revoked_at) return json(rpcErr(null, -32001, "Missing or invalid KarmanLang token. Create one on the admin page → Connect."), 401);
  await run(env, "UPDATE deploy_tokens SET last_used_at = ? WHERE id = ?", now(), row.id);

  const body = await req.json().catch(() => null);
  if (!body) return json(rpcErr(null, -32700, "Parse error"), 400);
  const batch = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of batch) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { out.push(rpcErr(m?.id ?? null, -32600, "Invalid request")); continue; }
    const isNote = m.id === undefined || m.id === null;
    switch (m.method) {
      case "initialize": {
        const want = m.params?.protocolVersion;
        out.push(rpc(m.id, { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS }));
        break;
      }
      case "ping": out.push(rpc(m.id, {})); break;
      case "tools/list": out.push(rpc(m.id, { tools: TOOLS })); break;
      case "tools/call": {
        try {
          const r = await runTool(env, url.origin, m.params?.name, m.params?.arguments ?? {});
          out.push(rpc(m.id, { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent: r }));
        } catch (e) {
          if (!(e instanceof HttpError)) console.error("mcp_tool_error", e?.stack || e);
          out.push(rpc(m.id, { content: [{ type: "text", text: e instanceof HttpError ? e.message : "Something went wrong on the KarmanLang server." }], isError: true }));
        }
        break;
      }
      default: if (!isNote) out.push(rpcErr(m.id, -32601, `Method not found: ${m.method}`));
    }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
}
