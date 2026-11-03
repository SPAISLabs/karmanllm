// Agent page: /<slug>. Enter an access code (or open a link with ?code=…), then chat.
(function () {
  const { api, esc, md, $ } = window.KL;
  const slug = decodeURIComponent(location.pathname.split("/")[1] || "").toLowerCase();
  const show = (id) => ["signin", "home", "missing", "chat"].forEach((s) => ($("#" + s).hidden = s !== id));
  let conv = null, busy = false;

  function setStatus(el, msg, kind) { el.textContent = msg || ""; el.className = "status" + (kind ? " " + kind : ""); }
  function addMsg(role, text, name) {
    const d = document.createElement("div");
    d.className = "msg " + (role === "user" ? "me" : "agent");
    d.innerHTML = `<div class="who">${esc(role === "user" ? "You" : name)}</div><div class="bubble">${role === "user" ? esc(text).replace(/\n/g, "<br>") : md(text)}</div>`;
    $("#log").append(d); $("#log").scrollTop = $("#log").scrollHeight;
    return d;
  }
  function showLeft(n) { $("#left").textContent = n == null ? "" : `${n} repl${n === 1 ? "y" : "ies"} left today`; }

  async function startChat(info) {
    const s = await api("start", { slug });
    conv = s.conversationId;
    show("chat");
    $("#who").hidden = false; $("#who-admin").hidden = !s.admin; $("#btn-signout").hidden = s.admin;
    $("#agent-name").textContent = s.agent.name; $("#agent-desc").textContent = s.agent.description || "";
    $("#log").innerHTML = ""; addMsg("assistant", s.greeting, s.agent.name);
    showLeft(s.remainingToday);
    $("#input").focus();
  }

  async function boot() {
    if (!slug) { show("home"); return; }
    let info;
    try { info = await api("agent_public", { slug }); }
    catch (e) { show("missing"); $("#missing-msg").textContent = e.message; return; }
    document.title = info.name + " · KarmanLang";
    $("#brand-sub").textContent = "· " + info.name;
    if (info.notice) { $("#notice").textContent = info.notice; $("#notice").hidden = false; }
    const params = new URLSearchParams(location.search);
    const linkCode = params.get("code");
    if (linkCode) { params.delete("code"); history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : "")); }
    if (!info.signedIn && linkCode) {
      try { await api("redeem", { slug, code: linkCode }); info.signedIn = true; }
      catch (e) { setStatus($("#signin-status"), e.message, "err"); }
    }
    if (info.signedIn) { try { return await startChat(info); } catch (e) { setStatus($("#signin-status"), e.message, "err"); } }
    show("signin");
    $("#signin-sub").textContent = info.description || `To use ${info.name}, enter the code you were given.`;
    $("#code").focus();
  }

  $("#code-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = $("#code").value.trim();
    if (!code) return setStatus($("#signin-status"), "Enter your code.", "err");
    $("#code-btn").disabled = true; setStatus($("#signin-status"), "Checking…");
    try { await api("redeem", { slug, code }); setStatus($("#signin-status"), ""); await startChat(); }
    catch (e) { setStatus($("#signin-status"), e.message, "err"); }
    finally { $("#code-btn").disabled = false; }
  });

  $("#compose").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const text = $("#input").value.trim();
    if (!text) return;
    busy = true; $("#btn-send").disabled = true; setStatus($("#status"), "");
    addMsg("user", text); $("#input").value = "";
    const name = $("#agent-name").textContent;
    const wait = addMsg("assistant", "…", name); wait.querySelector(".bubble").classList.add("thinking");
    try {
      const r = await api("chat", { slug, conversationId: conv, message: text });
      wait.remove(); addMsg("assistant", r.reply, name);
      if (r.truncated) setStatus($("#status"), "That reply hit the length limit. Ask it to continue.");
      showLeft(r.remainingToday);
    } catch (e) {
      wait.remove(); setStatus($("#status"), e.message, "err");
      if (e.code === "code") { show("signin"); setStatus($("#signin-status"), "Your access ended. Enter a code to continue.", "err"); }
      else $("#input").value = text;
    } finally { busy = false; $("#btn-send").disabled = false; $("#input").focus(); }
  });
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#compose").requestSubmit(); });
  $("#btn-new").addEventListener("click", () => startChat().catch((e) => setStatus($("#status"), e.message, "err")));
  $("#btn-signout").addEventListener("click", async () => { await api("signout", { slug }).catch(() => {}); location.reload(); });

  boot();
})();
