// Shared client: calls to /api (the session lives in an HttpOnly cookie), safe markdown, copy helper.
(function () {
  async function api(action, payload = {}) {
    let r;
    try {
      r = await fetch("/api", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...payload }) });
    } catch (e) { throw { code: "network", message: "Can't reach KarmanLang. Check your connection and try again." }; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.error || "http_" + r.status, message: j.message || "Something went wrong. Try again.", status: r.status };
    return j;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Small, safe markdown: paragraphs, **bold**, *italic*, `code`, ``` blocks, - lists, 1. lists, # headings.
  function md(src) {
    const blocks = String(src).split(/```/);
    return blocks.map((b, i) => {
      if (i % 2) return `<pre><code>${esc(b.replace(/^[a-z]*\n/, ""))}</code></pre>`;
      return b.trim().split(/\n{2,}/).map((p) => {
        const lines = p.split("\n");
        const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\W)\*(\S.*?\S|\S)\*(?=\W|$)/g, "$1<i>$2</i>");
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return "<ul>" + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("") + "</ul>";
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return "<ol>" + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("") + "</ol>";
        const h = p.match(/^(#{1,4})\s+(.*)$/);
        if (h && lines.length === 1) return `<h4>${inline(h[2])}</h4>`;
        return `<p>${lines.map(inline).join("<br>")}</p>`;
      }).join("");
    }).join("");
  }
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
    if (btn) { const o = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = o), 1200); }
  }
  const $ = (s, r = document) => r.querySelector(s);
  const when = (ms) => ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
  window.KL = { api, esc, md, copy, $, when };
})();
