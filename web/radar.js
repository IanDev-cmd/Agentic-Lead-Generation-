/* Analytics radar. Scores companies already on the desk. Light is the default. */
(function () {
  const AX = ["Tech stack fit", "Funding velocity", "Cloud & infra", "Market momentum", "Hiring & growth", "Intent signals"];
  const ST = ["Discovery & firmographics", "Tech stack audit", "Funding & financials", "Buying intent signals", "Competitive & ICP fit", "AI outreach angle", "Final score & CRM sync"];
  const FOC = [4, 0, 1, 5, -1, 3];
  const ICPS = [
    { l: "B2B AI / Series A", d: "Weights tech depth and intent", w: [1, 1, 1, 1, 1, 1] },
    { l: "Fintech infra / Seed–B", d: "Weights funding and momentum", w: [0.9, 1, 0.95, 1, 0.8, 0.85] },
    { l: "Healthtech SaaS / Series B", d: "Weights hiring and cloud posture", w: [0.8, 0.9, 1, 0.85, 1, 0.9] }
  ];
  const NS = "http://www.w3.org/2000/svg";
  const cx = 400;
  const cy = 250;
  const R = 178;
  const ANG = [-120, -60, 0, 60, 120, 180].map((deg) => deg * Math.PI / 180);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
  }
  function clip(value, max) {
    const text = String(value || "").replace(/[|]/g, "/").replace(/\s+/g, " ").trim();
    if (!text || /^unknown$/i.test(text) || text === "No public pain point.") return "";
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  function hostOf(domain) {
    const raw = String(domain || "").replace(/^https?:\/\//i, "").split("/")[0].trim();
    if (!raw || /\s/.test(raw) || !raw.includes(".")) return "";
    return raw;
  }
  function hit(text, pattern, yes, no) {
    return pattern.test(text) ? yes : no;
  }
  function rowsFrom(leads) {
    return (Array.isArray(leads) ? leads : []).filter((lead) => lead && lead.company && !lead.archived).map((lead) => {
      const text = `${lead.pain || ""} ${lead.hook || ""} ${lead.hq || ""}`.toLowerCase();
      const high = lead.priority === "High" && !lead.negative;
      const pain = clip(lead.pain, 36);
      const hook = clip(lead.hook, 36);
      const hq = clip(lead.hq, 36);
      const priority = high ? "High" : "Low";
      return {
        n: lead.company,
        d: hostOf(lead.domain),
        s: [hq, priority + " priority"].filter(Boolean).join(" · ") || "No public profile yet",
        hook: hook,
        v: [
          hit(text, /software|saas|api|stack|platform|cloud/, 0.84, 0.46),
          hit(text, /fund|series|seed|revenue|raise|capital/, 0.82, 0.38),
          hit(text, /aws|azure|gcp|cloud|infra|kubernetes/, 0.8, 0.4),
          high ? 0.76 : 0.36,
          hit(text, /hiring|role|job|headcount|recruit/, 0.82, 0.38),
          hook ? 0.8 : 0.32
        ],
        e: [
          `On file|${pain || "No pain point"}|${priority}`,
          `Funding|${hit(text, /fund|series|seed|revenue|raise|capital/, "Mentioned", "Not in sources")}`,
          `Infra|${hit(text, /aws|azure|gcp|cloud|infra|kubernetes/, "Mentioned", "Not in sources")}`,
          `Momentum|${priority}|${hq || "No headquarters"}`,
          `Hiring|${hit(text, /hiring|role|job|headcount|recruit/, "Mentioned", "Not in sources")}`,
          `Intent|${hook || "No public hook"}`
        ]
      };
    });
  }

  function ensureStyle() {
    if (document.getElementById("radar-style")) return;
    const style = document.createElement("style");
    style.id = "radar-style";
    style.textContent = `
.radar-app{--radar-bg:#f4f6f8;--radar-bar:#fff;--radar-g:#178a45;--radar-line:#c5ced6;--radar-tx:#1b2127;--radar-mut:#5e6972;--radar-disk:#fff;--radar-disk-2:#f7f8fa;--radar-disk-3:#e7edf2;--radar-grid:#d5dde4;--radar-node:#1b2127;--radar-step:#fff;--radar-step-line:#d5dde4;--radar-step-on:#e7f6ec;--radar-card:#fff;--radar-card-line:#e3e8ed;--radar-on-g:#06210f;--radar-poly:rgba(23,138,69,.22);--radar-done:#e7f6ec;--radar-shadow:rgba(20,28,36,.16);height:calc(100dvh - 100px);min-height:520px;display:grid;grid-template-rows:64px 1fr;background:var(--radar-bar);color:var(--radar-tx);font-family:Barlow,Inter,system-ui,sans-serif;border-radius:18px;overflow:hidden;box-shadow:0 16px 40px var(--radar-shadow);color-scheme:light}
.radar-app.is-dark{--radar-bg:#25292E;--radar-bar:#1E2125;--radar-g:#34C759;--radar-line:#5A626A;--radar-tx:#E8ECEF;--radar-mut:#8A939B;--radar-disk:#2B3035;--radar-disk-2:#2A2F34;--radar-disk-3:#31363C;--radar-grid:#3E454C;--radar-node:#25292E;--radar-step:#292d32;--radar-step-line:#30353b;--radar-step-on:#2b3330;--radar-card:#2B3035;--radar-card-line:#363c42;--radar-on-g:#0E2216;--radar-poly:rgba(52,199,89,.25);--radar-done:#2f3b33;--radar-shadow:rgba(0,0,0,.35);color-scheme:dark}
.radar-app button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
.radar-app button:focus-visible,.radar-app a:focus-visible{outline:2px solid var(--radar-g);outline-offset:2px}
.radar-app header{background:var(--radar-bar);display:flex;align-items:stretch;justify-content:space-between;gap:8px;padding-left:16px;border-bottom:1px solid var(--radar-card-line)}
.radar-app .lk{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.radar-app .lk a,.radar-app .theme{width:34px;height:34px;display:grid;place-items:center;color:var(--radar-mut);border-radius:6px}
.radar-app .lk a:hover,.radar-app .theme:hover{color:var(--radar-tx)}
.radar-app h1{margin:0;align-self:center;flex:2;text-align:center;font:600 22px "Barlow Condensed",Impact,sans-serif;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;color:var(--radar-tx)}
.radar-app .act{flex:1;display:flex;justify-content:flex-end;align-items:stretch;min-width:0}
.radar-app .ghost{padding:0 14px;font:500 14px "Barlow Condensed",sans-serif;letter-spacing:.06em;color:var(--radar-mut);text-transform:uppercase}
.radar-app .ghost:hover{color:var(--radar-tx)}
.radar-app .cta{padding:0 22px;background:var(--radar-g);color:var(--radar-on-g);font:700 15px "Barlow Condensed",sans-serif;letter-spacing:.06em;text-transform:uppercase}
.radar-app .cta:hover{filter:brightness(1.05)}
.radar-app .cta:disabled,.radar-app .ghost:disabled{opacity:.45;cursor:default}
.radar-app main{position:relative;background:var(--radar-bg);overflow:hidden;min-height:0}
.radar-app svg.plot{position:absolute;inset:0;width:100%;height:100%}
.radar-app .gl{filter:drop-shadow(0 0 6px rgba(52,199,89,.4))}
.radar-app .nd{cursor:pointer}
.radar-app .bub{animation:radar-pop .28s cubic-bezier(.2,.9,.3,1.2) both;transform-box:fill-box}
@keyframes radar-pop{from{opacity:0}to{opacity:1}}
.radar-app .lab{font:500 13px Barlow,sans-serif;fill:var(--radar-mut)}
.radar-app .steps{position:absolute;right:20px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:8px}
.radar-app .steps button{width:44px;height:36px;background:var(--radar-step);border:1px solid var(--radar-step-line);font:600 18px "Barlow Condensed",sans-serif;color:var(--radar-tx)}
.radar-app .steps button.on{color:var(--radar-g);border-color:var(--radar-g);background:var(--radar-step-on)}
.radar-app .steps button:hover{border-color:var(--radar-g)}
.radar-app .cap{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);font:500 14px Barlow,sans-serif;color:var(--radar-mut);text-align:center;width:50%}
.radar-app .cap b{color:var(--radar-tx);font-weight:600}
.radar-app .badge{position:absolute;left:24px;bottom:24px;width:148px;text-align:center;color:var(--radar-tx)}
.radar-app .badge svg{width:84px;height:84px;display:block;margin:0 auto 6px}
.radar-app .badge small{display:block;font:500 12px "Barlow Condensed",sans-serif;letter-spacing:.1em;color:var(--radar-mut);text-transform:uppercase}
.radar-app .badge strong{display:block;font:700 13px "Barlow Condensed",sans-serif;letter-spacing:.04em;color:var(--radar-g);text-transform:uppercase}
.radar-app .sum{position:absolute;inset:0 90px 0 0;display:none;align-items:center;justify-content:center;padding:20px}
.radar-app .sum.show{display:flex}
.radar-app .card{width:min(620px,100%);background:var(--radar-card);border:1px solid var(--radar-card-line);padding:28px 30px;color:var(--radar-tx)}
.radar-app .score{font:700 84px/1 "Barlow Condensed",sans-serif;color:var(--radar-g)}
.radar-app .score span{font-size:22px;color:var(--radar-mut);margin-left:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
.radar-app .card ul{list-style:none;padding:0;margin:18px 0}
.radar-app .card li{padding:10px 0;border-top:1px solid var(--radar-card-line);font-size:15px;line-height:1.4}
.radar-app .card li b{font-weight:600}
.radar-app .card p{margin:0 0 18px;color:var(--radar-mut);font-size:14px;line-height:1.5}
.radar-app .crm{display:flex;gap:10px;flex-wrap:wrap}
.radar-app .crm button{padding:11px 18px;background:var(--radar-g);color:var(--radar-on-g);font:700 15px "Barlow Condensed",sans-serif;letter-spacing:.06em;text-transform:uppercase}
.radar-app .crm button.done{background:var(--radar-done);color:var(--radar-g);cursor:default}
.radar-app .modal{position:absolute;inset:0;background:rgba(14,16,18,.45);display:none;place-items:center;z-index:4}
.radar-app.is-dark .modal{background:rgba(14,16,18,.7)}
.radar-app .modal.show{display:grid}
.radar-app .modal .card{width:min(420px,92%)}
.radar-app .modal h2{margin:0 0 14px;font:600 20px "Barlow Condensed",sans-serif;letter-spacing:.05em;text-transform:uppercase}
.radar-app .modal button.o{display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:8px;background:var(--radar-bg);border:1px solid var(--radar-card-line);font-size:15px;color:var(--radar-tx)}
.radar-app .modal button.o.on{border-color:var(--radar-g);color:var(--radar-g)}
.radar-app .modal button.o small{display:block;color:var(--radar-mut);margin-top:2px;font-size:12.5px}
.radar-app .radar-empty{position:absolute;inset:0;display:grid;place-items:center;margin:0;padding:24px;text-align:center;color:var(--radar-mut);font:500 16px Barlow,sans-serif}
.radar-app .radar-empty[hidden]{display:none}
@media(max-width:640px){.radar-app{height:calc(100dvh - 168px);min-height:420px}.radar-app h1{font-size:16px}.radar-app .ghost{padding:0 8px;font-size:12px}.radar-app .cta{padding:0 12px;font-size:13px}.radar-app .steps{right:6px;gap:5px}.radar-app .steps button{width:34px;height:30px;font-size:15px}.radar-app .badge{left:8px;bottom:8px;width:110px}.radar-app .badge svg{width:64px;height:64px}.radar-app .cap{width:56%;bottom:8px;font-size:12px}.radar-app .sum{inset:0 46px 0 0;padding:8px}.radar-app .score{font-size:60px}.radar-app .card{padding:18px}}
@media(prefers-reduced-motion:reduce){.radar-app .bub{animation:none}}
`;
    document.head.appendChild(style);
  }

  function mount(root, leads) {
    if (!root) return;
    ensureStyle();
    const LEADS = rowsFrom(leads);
    let dark = false;
    try { dark = localStorage.getItem("lead-desk-theme") === "dark"; } catch { dark = false; }
    root.innerHTML = `<div class="radar-app${dark ? " is-dark" : ""}">
<header>
  <div class="lk">
    <button type="button" class="theme" aria-pressed="${dark ? "true" : "false"}">${dark ? "Light" : "Dark"}</button>
    <a class="web" href="#" aria-label="Company website"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg></a>
  </div>
  <h1 class="title">Analytics</h1>
  <div class="act"><button type="button" class="ghost prev">Previous lead</button><button type="button" class="cta next">Approve &amp; next</button></div>
</header>
<main>
  <svg class="plot" viewBox="0 0 800 480" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Six-axis lead qualification radar"></svg>
  <p class="radar-empty" hidden>No companies to score yet. Research adds them here.</p>
  <div class="sum"></div>
  <div class="cap"></div>
  <button type="button" class="badge" aria-label="Change ICP scoring model">
    <svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="46" fill="var(--radar-disk-3)" stroke="var(--radar-grid)" stroke-width="2"/><circle cx="48" cy="48" r="18" fill="none" stroke="var(--radar-g)" stroke-width="4"/><path d="M48 30 L52 42 L64 44 L55 52 L58 64 L48 58 L38 64 L41 52 L32 44 L44 42 Z" fill="var(--radar-g)"/></svg>
    <small>Target ICP</small><strong class="icp"></strong>
  </button>
  <nav class="steps" aria-label="Agent pipeline stages"></nav>
  <div class="modal"><div class="card" role="dialog" aria-label="ICP scoring model"><h2>Scoring model</h2><div class="opts"></div></div></div>
</main>
</div>`;
    const app = root.querySelector(".radar-app");
    const svg = app.querySelector(".plot");
    const title = app.querySelector(".title");
    const empty = app.querySelector(".radar-empty");
    const sum = app.querySelector(".sum");
    const cap = app.querySelector(".cap");
    const steps = app.querySelector(".steps");
    const icpNode = app.querySelector(".icp");
    const modal = app.querySelector(".modal");
    const opts = app.querySelector(".opts");
    const web = app.querySelector(".web");
    const theme = app.querySelector(".theme");
    let li = 0;
    let st = 4;
    let icp = 0;
    let sel = null;
    let cur = [0, 0, 0, 0, 0, 0];
    let from = cur;
    let tgt = cur;
    let t0 = 0;
    let raf = 0;
    const pushed = {};
    const current = () => LEADS[li];
    const adj = () => current().v.map((value, index) => Math.min(1, value * ICPS[icp].w[index]));
    const vals = () => {
      const base = adj();
      if (st === 4 || st === 6) return base;
      return base.map((value, index) => (index === FOC[st] ? value : value * 0.55));
    };
    const score = () => Math.round(adj().reduce((sumValue, value) => sumValue + value, 0) / 6 * 100);
    const pt = (index, radius) => [cx + radius * Math.cos(ANG[index]), cy + radius * Math.sin(ANG[index])];
    const hex = (radius) => ANG.map((_, index) => pt(index, radius).join(",")).join(" ");

    function build() {
      let markup = `<circle cx="400" cy="250" r="125" fill="var(--radar-disk)"/><circle cx="400" cy="250" r="175" fill="var(--radar-disk-2)"/><circle cx="400" cy="250" r="232" fill="var(--radar-disk-3)" opacity=".55"/>`;
      [0.25, 0.5, 0.75, 1].forEach((scale) => {
        markup += `<polygon points="${hex(R * scale)}" fill="none" stroke="var(--radar-grid)" stroke-width="1"/>`;
      });
      ANG.forEach((_, index) => {
        const [x, y] = pt(index, R);
        const [ox, oy] = pt(index, R + 34);
        const left = Math.cos(ANG[index]) < 0;
        const ex = ox + (left ? -140 : 140);
        markup += `<line x1="400" y1="250" x2="${x}" y2="${y}" stroke="var(--radar-grid)" stroke-dasharray="5 5"/>`;
        [0.25, 0.5, 0.75].forEach((scale) => {
          const [tickX, tickY] = pt(index, R * scale);
          markup += `<circle cx="${tickX}" cy="${tickY}" r="3" fill="var(--radar-bg)" stroke="var(--radar-line)"/>`;
        });
        markup += `<line x1="${x}" y1="${y}" x2="${ox}" y2="${oy}" stroke="var(--radar-line)"/><circle cx="${ox}" cy="${oy}" r="3.5" fill="var(--radar-bg)" stroke="var(--radar-mut)"/><line x1="${ox}" y1="${oy}" x2="${ex}" y2="${oy}" stroke="var(--radar-line)"/><text class="lab" x="${ex}" y="${oy - 7}" text-anchor="${left ? "start" : "end"}">${esc(AX[index])}</text>`;
      });
      markup += `<polygon class="poly gl" fill="var(--radar-poly)" stroke="var(--radar-g)" stroke-width="2" stroke-linejoin="round"/><g class="nodes"></g><g class="bubs"></g>`;
      svg.innerHTML = markup;
      const nodes = svg.querySelector(".nodes");
      ANG.forEach((_, index) => {
        const node = document.createElementNS(NS, "g");
        node.setAttribute("class", "nd");
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "button");
        node.setAttribute("aria-label", AX[index] + " evidence");
        node.dataset.i = String(index);
        node.innerHTML = `<circle r="16" fill="transparent"/><circle class="o" r="6.5" fill="#fff"/><circle class="c" r="3" fill="var(--radar-node)"/>`;
        const focus = (event) => {
          event.stopPropagation();
          sel = index;
          bubs();
          draw();
        };
        node.addEventListener("click", focus);
        node.addEventListener("pointerenter", focus);
        node.addEventListener("focus", focus);
        nodes.appendChild(node);
      });
      svg.onclick = (event) => {
        if (event.target.closest(".nd")) return;
        sel = null;
        bubs();
        draw();
      };
    }
    const active = () => {
      if (!LEADS.length) return [];
      if (sel !== null) return [sel];
      if (st === 4) return adj().map((value, index) => [value, index]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((pair) => pair[1]);
      return FOC[st] >= 0 ? [FOC[st]] : [];
    };
    function bubs() {
      const holder = svg.querySelector(".bubs");
      if (!holder || !LEADS.length) return;
      holder.innerHTML = active().map((index) => {
        const parts = current().e[index].split("|");
        const label = parts[0];
        const chips = parts.slice(1);
        const widths = chips.map((chip) => chip.length * 6.4 + 16);
        let x = 0;
        const width = Math.max(label.length * 6 + 80, widths.reduce((sumWidth, chip) => sumWidth + chip + 5, -5) + 24);
        const height = 56;
        const chipMarkup = chips.map((chip, chipIndex) => {
          const piece = `<rect x="${12 + x}" y="31" width="${widths[chipIndex]}" height="18" rx="9" fill="var(--radar-tx)"/><text x="${12 + x + widths[chipIndex] / 2}" y="43.5" text-anchor="middle" font-size="11" font-weight="600" fill="var(--radar-bg)" font-family="Barlow,sans-serif">${esc(chip)}</text>`;
          x += widths[chipIndex] + 5;
          return piece;
        }).join("");
        return `<g class="bub" data-i="${index}" data-w="${width}" data-h="${height}" style="pointer-events:none"><rect width="${width}" height="${height}" rx="14" fill="#fff" stroke="var(--radar-card-line)" style="filter:drop-shadow(0 6px 10px var(--radar-shadow))"/><polygon class="tip" fill="#fff"/><text x="12" y="20" font-size="11" font-weight="600" fill="#5A626A" font-family="Barlow,sans-serif">${esc(AX[index])}: ${esc(label)}</text>${chipMarkup}</g>`;
      }).join("");
    }
    function draw() {
      const poly = svg.querySelector(".poly");
      if (!poly) return;
      poly.setAttribute("points", cur.map((value, index) => pt(index, R * Math.max(0.18, value)).join(",")).join(" "));
      const on = active();
      svg.querySelectorAll(".nd").forEach((node) => {
        const index = Number(node.dataset.i);
        const [x, y] = pt(index, R * Math.max(0.18, cur[index] || 0));
        node.setAttribute("transform", `translate(${x} ${y})`);
        node.querySelector(".o").setAttribute("fill", on.includes(index) ? "var(--radar-g)" : "#fff");
      });
      svg.querySelectorAll(".bub").forEach((bubble) => {
        const index = Number(bubble.dataset.i);
        const width = Number(bubble.dataset.w);
        const height = Number(bubble.dataset.h);
        const [nx, ny] = pt(index, R * Math.max(0.18, cur[index] || 0));
        const bx = Math.max(8, Math.min(792 - width, nx - width / 2));
        const by = ny - 18 - height;
        const tip = Math.max(18, Math.min(width - 18, nx - bx));
        bubble.setAttribute("transform", `translate(${bx} ${by})`);
        bubble.querySelector(".tip").setAttribute("points", `${tip - 7},${height - 1} ${tip + 7},${height - 1} ${tip},${height + 8}`);
      });
    }
    function go() {
      from = cur.slice();
      tgt = LEADS.length ? vals() : [0, 0, 0, 0, 0, 0];
      cancelAnimationFrame(raf);
      if (reduced) {
        cur = tgt;
        draw();
        return;
      }
      t0 = performance.now();
      const tick = (now) => {
        const progress = Math.min(1, (now - t0) / 650);
        const eased = 1 - Math.pow(1 - progress, 3);
        cur = from.map((value, index) => value + (tgt[index] - value) * eased);
        draw();
        if (progress < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    function meta() {
      const lead = current();
      title.textContent = `${lead.n} vs. ICP benchmark`;
      if (lead.d) {
        web.href = `https://${lead.d}`;
        web.target = "_blank";
        web.rel = "noopener";
      } else {
        web.removeAttribute("href");
      }
      icpNode.textContent = ICPS[icp].l;
      steps.querySelectorAll("button").forEach((button, index) => {
        button.classList.toggle("on", index === st);
        button.setAttribute("aria-current", index === st ? "step" : "false");
        button.disabled = false;
      });
      app.querySelector(".prev").disabled = LEADS.length < 2;
      app.querySelector(".next").disabled = LEADS.length < 2;
      cap.innerHTML = st === 6
        ? `<b>${esc(lead.n)}</b>: ${esc(lead.s)}`
        : `Lead ${li + 1} of ${LEADS.length}: ${esc(lead.s)}.<br><b>Stage ${Math.min(st + 1, 6)} of 6</b> ${esc(ST[st])}`;
    }
    function summary() {
      const lead = current();
      const ranked = adj().map((value, index) => [value, index]).sort((a, b) => b[0] - a[0]);
      const points = ranked.slice(0, 3).map(([value, index]) => {
        const chips = lead.e[index].split("|").slice(1).join(", ");
        return `<li><b>${esc(AX[index])}</b> (${Math.round(value * 100)}): ${esc(chips)}</li>`;
      }).join("");
      const weak = ranked[5][1];
      const strong = ranked[0][1];
      const angle = lead.hook || lead.e[strong].split("|").slice(1)[0] || "what is already public";
      const saved = pushed[li];
      sum.innerHTML = `<div class="card"><div class="score">${score()}%<span>ICP match</span></div><p>${esc(lead.n)}: ${esc(lead.s)}. Scored against ${esc(ICPS[icp].l)}.</p><ul>${points}<li><b>Weakest signal</b>: ${esc(AX[weak])} (${Math.round(ranked[5][0] * 100)}). Verify before outreach.</li></ul><p>Outreach angle: open with ${esc(angle)} and ask how ${esc(AX[strong].toLowerCase())} shapes the next quarter. Nothing is sent from this desk.</p><div class="crm"><button type="button" data-c="HubSpot" class="${saved === "HubSpot" ? "done" : ""}">${saved === "HubSpot" ? "Noted for HubSpot" : "Note for HubSpot"}</button><button type="button" data-c="Salesforce" class="${saved === "Salesforce" ? "done" : ""}">${saved === "Salesforce" ? "Noted for Salesforce" : "Note for Salesforce"}</button></div></div>`;
      sum.querySelectorAll(".crm button").forEach((button) => {
        button.onclick = () => {
          pushed[li] = button.dataset.c;
          summary();
        };
      });
    }
    function view() {
      if (!LEADS.length) {
        svg.style.display = "none";
        sum.classList.remove("show");
        empty.hidden = false;
        title.textContent = "Analytics";
        icpNode.textContent = ICPS[icp].l;
        cap.textContent = "";
        web.removeAttribute("href");
        app.querySelector(".prev").disabled = true;
        app.querySelector(".next").disabled = true;
        steps.querySelectorAll("button").forEach((button) => {
          button.classList.remove("on");
          button.disabled = true;
        });
        return;
      }
      empty.hidden = true;
      const finalStep = st === 6;
      svg.style.display = finalStep ? "none" : "block";
      sum.classList.toggle("show", finalStep);
      if (finalStep) summary();
      meta();
      sel = null;
      bubs();
      go();
    }
    function shift(delta) {
      if (LEADS.length < 2) return;
      li = (li + delta + LEADS.length) % LEADS.length;
      if (st === 6) st = 4;
      view();
    }
    theme.onclick = () => {
      dark = !app.classList.contains("is-dark");
      app.classList.toggle("is-dark", dark);
      theme.textContent = dark ? "Light" : "Dark";
      theme.setAttribute("aria-pressed", dark ? "true" : "false");
      try { localStorage.setItem("lead-desk-theme", dark ? "dark" : "light"); } catch { /* the toggle still applies for this view */ }
    };
    app.querySelector(".next").onclick = () => shift(1);
    app.querySelector(".prev").onclick = () => shift(-1);
    steps.innerHTML = ST.map((label, index) => `<button type="button" title="${esc(label)}" aria-label="${esc(label)}">${index < 6 ? "0" + (index + 1) : "S"}</button>`).join("");
    steps.querySelectorAll("button").forEach((button, index) => {
      button.onclick = () => {
        if (!LEADS.length) return;
        st = index;
        view();
      };
    });
    app.querySelector(".badge").onclick = () => {
      opts.innerHTML = ICPS.map((model, index) => `<button type="button" class="o ${index === icp ? "on" : ""}" data-i="${index}">${esc(model.l)}<small>${esc(model.d)}</small></button>`).join("");
      modal.classList.add("show");
      const first = opts.querySelector("button");
      if (first) first.focus();
      opts.querySelectorAll("button").forEach((button) => {
        button.onclick = () => {
          icp = Number(button.dataset.i);
          modal.classList.remove("show");
          view();
        };
      });
    };
    modal.onclick = (event) => {
      if (event.target === modal) modal.classList.remove("show");
    };
    if (!root.dataset.radarKeys) {
      root.dataset.radarKeys = "1";
      document.addEventListener("keydown", (event) => {
        const host = document.getElementById("view-analytics");
        if (!host || host.hidden || !host.contains(document.activeElement) && event.key !== "Escape") return;
        const open = host.querySelector(".modal.show");
        if (event.key === "Escape" && open) {
          open.classList.remove("show");
          event.stopPropagation();
        }
      });
    }
    build();
    view();
  }

  window.Radar = { mount };
})();
