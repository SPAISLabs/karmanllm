#!/usr/bin/env node
// karman: deploy and manage KarmanLang agents from a terminal.
// Talks to the same MCP endpoint Claude and ChatGPT use. Needs Node 18+.
//   export KARMAN_ENDPOINT=https://<your-worker>/mcp   KARMAN_TOKEN=kl_...   (admin page → Connect)
//   karman deploy nqry --name "NQRY Tutor" --instructions prompt.md
//   karman code nqry "Ana – Lincoln HS"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENDPOINT = process.env.KARMAN_ENDPOINT || "";
const TOKEN = process.env.KARMAN_TOKEN || "";
const CACHE = join(homedir(), ".cache", "karman", "agents.txt");

const HELP = `karman — deploy agents as private web apps

  karman agents                         list your agents
  karman deploy <slug> [options]        create or update an agent
      --name "Display name"   --instructions <file|->   --description "…"
      --greeting "…"          --notice "…"              --model <id>   --daily <n>
  karman show <slug>                    settings, links, codes
  karman code <slug> "Who it's for" [--days <n>] [--daily <n>]
                                        create an access code
  karman codes <slug>                   list access codes
  karman uncode <slug> <id|last4|label> turn off a code
  karman pause <slug> | resume <slug>
  karman usage <slug> [--days 30]
  karman completion bash|zsh            print shell completion (eval it)

Environment: KARMAN_ENDPOINT and KARMAN_TOKEN (both from the admin page → Connect)`;

let rpcId = 0;
async function call(name, args = {}) {
  if (!TOKEN || !ENDPOINT) die("Set KARMAN_ENDPOINT and KARMAN_TOKEN first. Both are on the KarmanLang admin page → Connect.");
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  }).catch(() => die("Can't reach KarmanLang. Check your connection."));
  const j = await r.json().catch(() => die(`Unexpected response (HTTP ${r.status}).`));
  if (j.error) die(j.error.message);
  const res = j.result;
  if (res.isError) die(res.content?.[0]?.text || "Request failed.");
  return res.structuredContent ?? JSON.parse(res.content[0].text);
}
function die(msg) { console.error("karman: " + msg); process.exit(1); }

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; opt[k] = v; }
    else pos.push(a);
  }
  return { pos, opt };
}
function readInstructions(src) {
  if (src === "-") return readFileSync(0, "utf8");
  if (existsSync(src)) return readFileSync(src, "utf8");
  return src;
}
function cacheAgents(list) { try { mkdirSync(join(homedir(), ".cache", "karman"), { recursive: true }); writeFileSync(CACHE, list.join("\n")); } catch {} }
const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
const int = (v, name) => { const n = parseInt(v, 10); if (!Number.isInteger(n)) die(`--${name} needs a number.`); return n; };

const COMPLETION = {
  bash: `_karman() {
  local cur prev cmds; cur="\${COMP_WORDS[COMP_CWORD]}"; prev="\${COMP_WORDS[1]}"
  cmds="agents deploy show code codes uncode pause resume usage completion"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "$cmds" -- "$cur") ); return; fi
  if [ "$COMP_CWORD" -eq 2 ] && [[ " deploy show code codes uncode pause resume usage " == *" $prev "* ]]; then
    COMPREPLY=( $(compgen -W "$(karman __slugs 2>/dev/null)" -- "$cur") ); return; fi
  if [[ "$cur" == --* ]] && [ "$prev" = deploy ]; then
    COMPREPLY=( $(compgen -W "--name --instructions --description --greeting --notice --model --daily" -- "$cur") ); fi
}
complete -F _karman karman`,
  zsh: `_karman() {
  local -a cmds; cmds=(agents deploy show code codes uncode pause resume usage completion)
  if (( CURRENT == 2 )); then compadd -- $cmds; return; fi
  if (( CURRENT == 3 )); then compadd -- \${(f)"$(karman __slugs 2>/dev/null)"}; return; fi
  [[ $words[2] == deploy ]] && compadd -- --name --instructions --description --greeting --notice --model --daily
}
compdef _karman karman`,
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  switch (cmd) {
    case undefined: case "help": case "--help": case "-h": return out(HELP);
    case "completion": return out(COMPLETION[pos[0]] || die("Use: karman completion bash|zsh"));
    case "__slugs": {
      try { out(readFileSync(CACHE, "utf8")); } catch {}
      if (TOKEN) { try { const r = await call("list_agents"); cacheAgents(r.agents.map((a) => a.slug)); } catch {} }
      return;
    }
    case "agents": {
      const r = await call("list_agents");
      cacheAgents(r.agents.map((a) => a.slug));
      if (!r.agents.length) return out("No agents yet. Try: karman deploy my-agent --name \"My Agent\" --instructions prompt.md");
      return out(r.agents.map((a) => `${a.slug.padEnd(22)} ${a.status.padEnd(7)} ${a.name}\n${"".padEnd(31)}${a.url}`).join("\n"));
    }
    case "deploy": {
      const slug = pos[0] || die("Give a slug: karman deploy <slug> --instructions prompt.md");
      const args = { slug, name: opt.name || slug };
      if (opt.instructions) args.instructions = readInstructions(opt.instructions);
      for (const k of ["description", "greeting", "notice", "model"]) if (typeof opt[k] === "string") args[k] = opt[k];
      if (opt.daily) args.daily_limit = int(opt.daily, "daily");
      const r = await call("deploy_agent", args);
      return out(`${r.created ? "Deployed" : "Updated"} ${r.agent.name} (v${r.agent.version})\n  Link:   ${r.url}\n  Admin:  ${r.admin_url}\n  Next:   karman code ${r.agent.slug} "Who it's for"`);
    }
    case "show": return out(await call("describe_agent", { slug: pos[0] }));
    case "code": {
      if (!pos[0]) die('Use: karman code <slug> "Who it\'s for" [--days n] [--daily n]');
      const args = { slug: pos[0], label: pos.slice(1).join(" ") || undefined };
      if (opt.days) args.expires_days = int(opt.days, "days");
      if (opt.daily) args.daily_limit = int(opt.daily, "daily");
      const r = await call("create_code", args);
      return out(`Code:  ${r.code}${r.label ? "   (" + r.label + ")" : ""}\nLink:  ${r.link}\nOne-click sign-in:  ${r.link_with_code}`);
    }
    case "codes": {
      const r = await call("list_codes", { slug: pos[0] });
      if (!r.codes.length) return out(`No codes yet. Try: karman code ${pos[0]} "Ana"`);
      return out(r.codes.map((c) => `…${c.last4}  ${c.status.padEnd(8)} ${String(c.replies).padStart(5)} replies  ${c.label || ""}`).join("\n"));
    }
    case "uncode": {
      if (pos.length < 2) die("Use: karman uncode <slug> <id|last4|label>");
      const r = await call("revoke_code", { slug: pos[0], code: pos.slice(1).join(" ") });
      return out(`Turned off …${r.hint}${r.label ? " (" + r.label + ")" : ""}.`);
    }
    case "pause": case "resume": {
      const r = await call("update_agent", { slug: pos[0], status: cmd === "pause" ? "paused" : "active" });
      return out(`${r.agent.slug} is now ${r.agent.status}.`);
    }
    case "usage": {
      const r = await call("get_usage", { slug: pos[0], days: opt.days ? int(opt.days, "days") : 30 });
      out(`Last ${r.days} days: ${r.replies} replies, ${r.input_tokens.toLocaleString()} in / ${r.output_tokens.toLocaleString()} out tokens`);
      for (const u of r.by_code) out(`  ${u.who.padEnd(32)} ${String(u.replies).padStart(5)} replies`);
      return;
    }
    default: die(`Unknown command "${cmd}". Run karman help.`);
  }
}
main();
