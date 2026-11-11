/* Loads the Simulation Lab (CSS + sim-core.js + sim-lab.js) only when the operator opens it, so the dashboard's first load stays light. */
(() => {
  "use strict";
  const demo = location.pathname === "/" || location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1";
  const mount = document.getElementById("simLabMount");
  if (!mount) return;
  if (demo) { mount.hidden = true; return; }
  const V = "20261110-01", mk = (t, p) => Object.assign(document.createElement(t), p || {});
  const title = mk("div", { className: "cardHeader" }); title.append(mk("b", { textContent: "SIMULATION LAB" }), mk("span", { className: "simChip simChipWarn", textContent: "SOFTWARE ONLY" }));
  const note = mk("div", { className: "simNote", textContent: "Autonomous exploration, 15-minute offline operation, event sync and return-to-base, simulated entirely in your browser. Loads on demand." });
  const msg = mk("div", { className: "simMsg", role: "status" });
  const open = mk("button", { type: "button", id: "simLabOpen", className: "simBtn simPrimary", textContent: "OPEN SIMULATION LAB" });
  const row = mk("div", { className: "simRow" }); row.append(open);
  mount.className = "card simLabCard"; mount.append(title, note, row, msg);
  const css = () => new Promise((ok, no) => { const l = mk("link", { rel: "stylesheet", href: "/sim-lab.css?v=" + V }); l.onload = ok; l.onerror = () => no(new Error("sim-lab.css")); document.head.appendChild(l); });
  const js = src => new Promise((ok, no) => { const s = mk("script", { src: src + "?v=" + V }); s.onload = ok; s.onerror = () => no(new Error(src)); document.body.appendChild(s); });
  let loading = false;
  async function load() {
    if (loading) return; loading = true; open.disabled = true; msg.textContent = "Loading simulation…";
    try { await css(); await js("/sim-core.js"); mount.textContent = ""; await js("/sim-lab.js"); }
    catch (e) { if (!mount.contains(open)) { mount.append(title, note, row, msg); } msg.textContent = "Could not load the Simulation Lab (" + (e && e.message || "network error") + "). Check your connection and try again."; open.disabled = false; loading = false; }
  }
  open.addEventListener("click", load);
  if (location.hash === "#simlab") load();
})();
