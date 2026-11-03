// Admin console: agents, access codes, settings, usage, conversations, connector tokens.
(function () {
  const { api, esc, copy, $, when } = window.KL;
  let agents = [], current = null, origin = location.origin;
  const views = ["empty", "connect", "agent", "newagent"];
  const view = (id) => views.forEach((v) => ($("#" + v).hidden = v !== id));
  const fail = (e) => alert(e.message || String(e));

  // ---------- sign-in ----------
  async function boot() {
    const me = await api("admin_me").catch(() => ({ admin: false }));
    if (!me.admin) { $("#signin").hidden = false; $("#pw").focus(); return; }
    origin = me.origin || origin;
    $("#signin").hidden = true; $("#console").hidden = false; $("#who").hidden = false;
    await loadAgents(new URLSearchParams(location.search).get("a"));
  }
  $("#pw-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("#pw-btn").disabled = true; $("#signin-status").textContent = "Signing in…"; $("#signin-status").className = "status";
    try { await api("admin_login", { password: $("#pw").value }); $("#pw").value = ""; await boot(); }
    catch (e) { $("#signin-status").textContent = e.message; $("#signin-status").className = "status err"; }
    finally { $("#pw-btn").disabled = false; }
  });
  $("#btn-signout").addEventListener("click", async () => { await api("admin_logout").catch(() => {}); location.href = "/admin"; });

  // ---------- agent list ----------
  async function loadAgents(select) {
    agents = (await api("agents")).agents;
    $("#agentlist").innerHTML = agents.map((a) =>
      `<button data-slug="${esc(a.slug)}" aria-current="${a.slug === select}"><b>${esc(a.name)}</b><small>/${esc(a.slug)} · ${a.codes} code${a.codes === 1 ? "" : "s"}${a.status === "paused" ? " · paused" : ""}</small></button>`).join("");
    if (select && agents.some((a) => a.slug === select)) return openAgent(select);
    view("empty");
  }
  $("#agentlist").addEventListener("click", (e) => { const b = e.target.closest("button[data-slug]"); if (b) openAgent(b.dataset.slug); });

  async function openAgent(slug) {
    const r = await api("agent", { slug });
    current = { ...r.agent, url: r.url };
    history.replaceState(null, "", "/admin?a=" + encodeURIComponent(slug));
    document.querySelectorAll("#agentlist button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.slug === slug)));
    $("#a-name").textContent = current.name;
    $("#a-status").textContent = current.status; $("#a-status").className = "pill " + current.status;
    $("#a-open").href = r.url; $("#a-url").textContent = r.url;
    $("#c-new").hidden = true;
    view("agent"); tab("share");
  }

  // ---------- tabs ----------
  function tab(name) {
    document.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
    ({ share: loadCodes, settings: renderSettings, usage: loadUsage, convos: loadConvos })[name]().catch(fail);
  }
  document.querySelectorAll("[role=tab]").forEach((b) => b.addEventListener("click", () => tab(b.dataset.tab)));

  // ---------- share: codes ----------
  async function loadCodes() {
    const { codes } = await api("codes", { slug: current.slug });
    $("#codes").innerHTML = codes.length
      ? `<thead><tr><th>For</th><th>Code</th><th>Status</th><th>Replies</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>` +
        codes.map((c) => `<tr><td>${esc(c.label || "—")}</td><td><code class="inline">…${esc(c.hint)}</code></td>
          <td><span class="pill ${c.status === "active" ? "good" : c.status === "unused" ? "" : "revoked"}">${c.status}</span></td>
          <td>${c.replies}</td><td>${when(c.last_used_at)}</td><td>${c.expires_at ? when(c.expires_at) : "never"}</td>
          <td>${c.status === "revoked" || c.status === "expired" ? "" : `<button class="btn danger" data-revoke="${esc(c.id)}">Turn off</button>`}</td></tr>`).join("") + "</tbody>"
      : `<tbody><tr><td class="muted">No codes yet. Generate one for each person who should have access.</td></tr></tbody>`;
  }
  $("#codes").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-revoke]"); if (!b) return;
    if (!confirm("Turn off this code? Anyone using it is signed out.")) return;
    await api("revoke_code", { slug: current.slug, id: b.dataset.revoke }).catch(fail);
    loadCodes().catch(fail);
  });
  const num = (el) => { const n = parseInt(el.value, 10); return Number.isInteger(n) && n > 0 ? n : undefined; };
  $("#code-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("create_code", { slug: current.slug, label: $("#c-label").value.trim(), expires_days: num($("#c-days")), daily_limit: num($("#c-limit")) });
      $("#c-code").textContent = r.code; $("#c-link").textContent = r.link_with_code; $("#c-new").hidden = false;
      $("#c-label").value = ""; $("#c-days").value = ""; $("#c-limit").value = "";
      await loadCodes(); loadAgents(current.slug).catch(() => {});
    } catch (e) { fail(e); }
  });
  $("#c-code-copy").addEventListener("click", (e) => copy($("#c-code").textContent, e.target));
  $("#c-link-copy").addEventListener("click", (e) => copy($("#c-link").textContent, e.target));
  $("#a-url-copy").addEventListener("click", (e) => copy($("#a-url").textContent, e.target));

  // ---------- settings / new agent ----------
  function fields(a = {}, isNew = false) {
    return `${isNew ? `<h2>New agent</h2>` : ""}
      <div class="grid2">
        <label class="f">Name<input type="text" name="name" required maxlength="80" value="${esc(a.name || "")}"></label>
        <label class="f">Address<span class="hint">${esc(origin)}/<b>slug</b></span><input type="text" name="slug" ${isNew ? "" : "disabled"} maxlength="40" value="${esc(a.slug || "")}" placeholder="from the name"></label>
      </div>
      <label class="f">Instructions<span class="hint">The agent's full system prompt.</span><textarea name="instructions" rows="14" required>${esc(a.instructions || "")}</textarea></label>
      <label class="f">Description<span class="hint">One line on the sign-in page.</span><input type="text" name="description" maxlength="400" value="${esc(a.description || "")}"></label>
      <label class="f">Greeting<input type="text" name="greeting" maxlength="1000" value="${esc(a.greeting || "")}"></label>
      <label class="f">Notice banner<input type="text" name="notice" maxlength="600" value="${esc(a.notice || "")}" placeholder="e.g. Educators only. Not for student use."></label>
      <div class="grid2">
        <label class="f">Model<input type="text" name="model" value="${esc(a.model || "claude-sonnet-5-5")}"></label>
        <label class="f">Replies per person per day<input type="number" name="daily_limit" min="1" max="10000" value="${a.daily_limit ?? 100}"></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">${isNew ? "Deploy" : "Save"}</button>
        ${isNew ? "" : `<button class="btn" type="button" id="btn-pause">${a.status === "paused" ? "Resume" : "Pause"}</button>
        <span class="spacer"></span><button class="btn danger" type="button" id="btn-delete">Delete agent</button>`}
        <span class="status" id="save-status" role="status"></span></div>`;
  }
  function formData(form) {
    const f = Object.fromEntries(new FormData(form));
    const out = { name: f.name, instructions: f.instructions, description: f.description, greeting: f.greeting, notice: f.notice, model: f.model };
    if (f.slug) out.slug = f.slug;
    const d = parseInt(f.daily_limit, 10); if (Number.isInteger(d)) out.daily_limit = d;
    return out;
  }
  async function renderSettings() {
    const f = $("#settings"); f.innerHTML = fields(current);
    $("#btn-pause").onclick = async () => {
      await api("save_agent", { agent: { slug: current.slug, status: current.status === "paused" ? "active" : "paused" } }).catch(fail);
      await loadAgents(current.slug); tab("settings");
    };
    $("#btn-delete").onclick = async () => {
      const t = prompt(`This deletes ${current.name}, its codes and all conversations. Type "${current.slug}" to confirm.`);
      if (t !== current.slug) return;
      await api("delete_agent", { slug: current.slug, confirm: t }).catch(fail);
      history.replaceState(null, "", "/admin"); await loadAgents();
    };
  }
  $("#settings").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const s = $("#save-status"); s.textContent = "Saving…"; s.className = "status";
    try { await api("save_agent", { agent: { ...formData(ev.target), slug: current.slug } }); await loadAgents(current.slug); tab("settings"); $("#save-status").textContent = "Saved."; $("#save-status").className = "status ok"; }
    catch (e) { s.textContent = e.message; s.className = "status err"; }
  });
  $("#btn-new-agent").addEventListener("click", () => {
    current = null; $("#settings").innerHTML = ""; $("#newagent").innerHTML = fields({}, true); view("newagent");
    document.querySelectorAll("#agentlist button").forEach((b) => b.setAttribute("aria-current", "false"));
  });
  $("#newagent").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const s = $("#save-status"); s.textContent = "Deploying…"; s.className = "status";
    try { const r = await api("save_agent", { agent: formData(ev.target) }); await loadAgents(r.agent.slug); }
    catch (e) { s.textContent = e.message; s.className = "status err"; }
  });

  // ---------- usage ----------
  async function loadUsage() {
    const u = await api("usage", { slug: current.slug, days: 30 });
    $("#usage").innerHTML = `<div class="stats">
        <div class="stat"><b>${u.replies.toLocaleString()}</b><span>replies, last ${u.days} days</span></div>
        <div class="stat"><b>${(u.input_tokens + u.output_tokens).toLocaleString()}</b><span>tokens</span></div>
        <div class="stat"><b>${u.by_code.filter((x) => x.hint).length}</b><span>people active</span></div></div>
      <div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Who</th><th>Replies</th><th>Tokens</th></tr></thead><tbody>
      ${u.by_code.map((x) => `<tr><td>${esc(x.who)}</td><td>${x.replies}</td><td>${x.tokens.toLocaleString()}</td></tr>`).join("") || `<tr><td class="muted" colspan="3">No use yet.</td></tr>`}
      </tbody></table></div>`;
  }

  // ---------- conversations ----------
  async function loadConvos() {
    const { conversations } = await api("conversations", { slug: current.slug });
    $("#convos").innerHTML = conversations.length
      ? `<div class="tbl-wrap"><table><thead><tr><th>Started</th><th>Who</th><th>Replies</th><th></th></tr></thead><tbody>` +
        conversations.map((c) => `<tr><td>${when(c.created_at)}</td><td>${esc(c.who)}</td><td>${c.replies}</td><td><button class="btn" data-conv="${esc(c.id)}">Read</button></td></tr>`).join("") +
        `</tbody></table></div><div class="transcript" id="transcript" style="margin-top:12px"></div>`
      : `<p class="muted" style="margin:0">No conversations yet.</p>`;
  }
  $("#convos").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-conv]"); if (!b) return;
    const { messages } = await api("conversations", { slug: current.slug, id: b.dataset.conv }).catch((x) => (fail(x), { messages: [] }));
    $("#transcript").innerHTML = messages.map((m) => `<div class="${m.role === "user" ? "u" : ""}"><b>${m.role === "user" ? "Person" : esc(current.name)}:</b> ${esc(m.content)}</div>`).join("");
  });

  // ---------- connect ----------
  async function loadTokens(r) {
    const { tokens } = r || await api("tokens");
    $("#tok-table").innerHTML = tokens.length
      ? `<thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>` +
        tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>${when(t.created_at)}</td><td>${when(t.last_used_at)}</td>
          <td>${t.revoked_at ? `<span class="pill revoked">revoked</span>` : `<button class="btn danger" data-tok="${esc(t.id)}">Revoke</button>`}</td></tr>`).join("") + "</tbody>"
      : "";
  }
  $("#btn-connect").addEventListener("click", () => { current = null; view("connect"); $("#tok-secret").hidden = true; loadTokens().catch(fail); });
  $("#btn-tok").addEventListener("click", async () => {
    try {
      const r = await api("tokens", { op: "create", name: $("#tok-name").value.trim() || "Connector" });
      $("#tok-url").textContent = r.connector_url;
      $("#tok-cli").textContent = `export KARMAN_ENDPOINT=${r.endpoint}\nexport KARMAN_TOKEN=${r.token}`;
      $("#tok-secret").hidden = false; $("#tok-name").value = "";
      loadTokens();
    } catch (e) { fail(e); }
  });
  $("#tok-copy").addEventListener("click", (e) => copy($("#tok-url").textContent, e.target));
  $("#tok-table").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tok]"); if (!b || !confirm("Revoke this token? Anything using it stops working.")) return;
    loadTokens(await api("tokens", { op: "revoke", id: b.dataset.tok }).catch(fail));
  });

  boot().catch(fail);
})();
