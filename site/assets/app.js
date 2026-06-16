/* Kubernetes Notes — static SPA: markdown loader + mermaid + deep-dive drawer */
(function () {
  "use strict";

  const ROUTES = {
    part1: { file: "content/part1.md", title: "Part 1 · Foundations" },
    part2: { file: "content/part2.md", title: "Part 2 · Config, Scaling, GitOps" },
    part3: { file: "content/part3.md", title: "Part 3 · Helm & Case Studies" },
    part4: { file: "content/part4.md", title: "Part 4 · Reference Helm Charts" },
    part5: { file: "content/part5.md", title: "Part 5 · kubectl & Sample Manifests" },
    setup: { file: "content/setup.md", title: "SETUP · GitOps Deployment" },
  };
  const DEFAULT_ROUTE = "part1";

  const $ = (s, r = document) => r.querySelector(s);
  const article = $("#article");
  const drawer = $("#drawer");
  const drawerBody = $("#drawerBody");
  const drawerScrim = $("#drawerScrim");
  const loading = $("#loading");
  const tocEl = $("#toc");

  const mdCache = new Map();
  let mermaidSeq = 0;
  const drawerStack = [];

  /* ---------- theme ---------- */
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") || "dark";
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("knotes-theme", theme);
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: theme === "dark" ? "dark" : "default" });
  }
  (function initTheme() {
    const saved = localStorage.getItem("knotes-theme") || "dark";
    applyTheme(saved);
  })();
  $("#themeBtn").addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
    // re-render current content so mermaid picks up the new theme
    renderRoute(true);
    if (!drawer.hidden && drawerStack.length) openDeep(drawerStack[drawerStack.length - 1], true);
  });

  /* ---------- markdown fetch ---------- */
  async function fetchMd(path) {
    if (mdCache.has(path)) return mdCache.get(path);
    // no-cache: always revalidate so an edited .md is never masked by a stale
    // browser HTTP cache (the cause of "old diagram still showing the error").
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error("Could not load " + path + " (" + res.status + ")");
    const text = await res.text();
    mdCache.set(path, text);
    return text;
  }

  function slugify(s) {
    return s.toLowerCase().trim()
      .replace(/[^\w\s§.-]/g, "")
      .replace(/[\s.]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  /* ---------- render markdown -> DOM, then enhance ---------- */
  async function renderMarkdownInto(container, md, opts = {}) {
    marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });
    container.innerHTML = marked.parse(md);

    // 1. mermaid: convert ```mermaid code blocks to <div class="mermaid">
    container.querySelectorAll("pre > code.language-mermaid").forEach((code) => {
      const div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = code.textContent;
      code.parentElement.replaceWith(div);
    });

    // 2. syntax highlight remaining code blocks + add copy buttons
    container.querySelectorAll("pre > code").forEach((code) => {
      if (code.classList.contains("language-mermaid")) return;
      try { hljs.highlightElement(code); } catch (e) {}
      const pre = code.parentElement;
      if (pre.parentElement.classList.contains("code-wrap")) return;
      const wrap = document.createElement("div");
      wrap.className = "code-wrap";
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const text = code.innerText;
        const done = () => { btn.textContent = "Copied!"; btn.classList.add("copied"); setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        } else { fallbackCopy(text, done); }
      });
      wrap.appendChild(btn);
    });

    // 3. heading ids + anchor links (only for main article)
    if (opts.toc) {
      container.querySelectorAll("h2, h3").forEach((h) => {
        const id = slugify(h.textContent);
        h.id = id;
        const a = document.createElement("a");
        a.className = "anchor";
        a.href = "#" + location.hash.split("#").slice(1, 2).join("") + "#" + id;
        a.textContent = "#";
        a.addEventListener("click", (e) => { e.preventDefault(); scrollToId(id); history.replaceState(null, "", "#/" + opts.route + "#" + id); });
        h.appendChild(a);
      });
    }

    // 4. deep-dive links
    container.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("deep:")) {
        const slug = href.slice(5);
        a.classList.add("deep-link");
        a.removeAttribute("href");
        a.setAttribute("role", "button");
        a.tabIndex = 0;
        a.addEventListener("click", (e) => { e.preventDefault(); openDeep(slug); });
        a.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); openDeep(slug); } });
      } else if (href.startsWith("http")) {
        a.target = "_blank";
        a.rel = "noopener";
      }
    });

    // 5. render mermaid diagrams + add zoom affordance
    const nodes = [...container.querySelectorAll(".mermaid")];
    if (nodes.length) {
      nodes.forEach((n) => { n.removeAttribute("data-processed"); n.id = "mmd-" + (mermaidSeq++); });
      try { await mermaid.run({ nodes }); } catch (e) { console.warn("mermaid render", e); }
      nodes.forEach((n) => {
        const svg = n.querySelector("svg");
        if (!svg) return;
        n.setAttribute("data-zoomable", "1");
        const zb = document.createElement("button");
        zb.className = "zoom-btn";
        zb.type = "button";
        zb.textContent = "⤢ zoom";
        zb.addEventListener("click", (e) => { e.stopPropagation(); openZoom(svg); });
        n.appendChild(zb);
        n.addEventListener("click", (e) => { if (e.target.closest(".zoom-btn")) return; openZoom(svg); });
      });
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ---------- main route render ---------- */
  function parseHash() {
    // forms: #/part1  or  #/part1#section-id
    const raw = location.hash.replace(/^#\/?/, "");
    const [route, anchor] = raw.split("#");
    return { route: ROUTES[route] ? route : DEFAULT_ROUTE, anchor: anchor || "" };
  }

  async function renderRoute(isRerender) {
    const { route, anchor } = parseHash();
    const cfg = ROUTES[route];
    loading.hidden = false;
    try {
      const md = await fetchMd(cfg.file);
      await renderMarkdownInto(article, md, { toc: true, route });
      buildToc(route);
      setActiveNav(route);
      document.title = cfg.title + " — Kubernetes Notes";
      if (!isRerender) {
        if (anchor) { setTimeout(() => scrollToId(anchor), 60); }
        else { $("#main").scrollTop = 0; window.scrollTo(0, 0); }
      }
    } catch (e) {
      article.innerHTML = '<h1>⚠ Load error</h1><p>' + e.message +
        '</p><p>This site loads <code>.md</code> files via <code>fetch()</code>, so it must be served over HTTP (not opened as a <code>file://</code> path). Run a static server in the <code>site/</code> folder, e.g. <code>python -m http.server</code>.</p>';
    } finally {
      loading.hidden = true;
    }
  }

  function scrollToId(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- TOC + scrollspy ---------- */
  let tocLinks = [];
  function buildToc(route) {
    tocEl.innerHTML = "";
    tocLinks = [];
    article.querySelectorAll("h2, h3").forEach((h) => {
      const a = document.createElement("a");
      a.textContent = h.textContent.replace(/#$/, "").trim();
      a.href = "#/" + route + "#" + h.id;
      a.className = h.tagName === "H3" ? "h3" : "";
      a.dataset.target = h.id;
      a.addEventListener("click", (e) => { e.preventDefault(); scrollToId(h.id); history.replaceState(null, "", a.getAttribute("href")); closeSidebarMobile(); });
      tocEl.appendChild(a);
      tocLinks.push(a);
    });
  }
  function onScroll() {
    if (!tocLinks.length) return;
    let activeId = null;
    const headings = article.querySelectorAll("h2, h3");
    headings.forEach((h) => { if (h.getBoundingClientRect().top < 120) activeId = h.id; });
    tocLinks.forEach((a) => a.classList.toggle("active", a.dataset.target === activeId));
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  function setActiveNav(route) {
    document.querySelectorAll(".nav-link").forEach((a) =>
      a.classList.toggle("active", a.dataset.route === route));
  }

  /* ---------- deep-dive drawer ---------- */
  async function openDeep(slug, isRerender) {
    if (!isRerender) drawerStack.push(slug);
    drawerScrim.hidden = false;
    drawer.hidden = false;
    $("#drawerBack").hidden = drawerStack.length <= 1;
    drawerBody.innerHTML = '<p style="color:var(--text-dim)">Loading…</p>';
    try {
      const md = await fetchMd("content/deep/" + slug + ".md");
      await renderMarkdownInto(drawerBody, md, {});
      drawerBody.scrollTop = 0;
    } catch (e) {
      drawerBody.innerHTML = "<h1>Not found</h1><p>No deep-dive article for <code>" + slug + "</code> yet.</p><p style='color:var(--text-dim)'>" + e.message + "</p>";
    }
  }
  function closeDrawer() {
    drawer.hidden = true;
    drawerScrim.hidden = true;
    drawerStack.length = 0;
  }
  $("#drawerClose").addEventListener("click", closeDrawer);
  drawerScrim.addEventListener("click", closeDrawer);
  $("#drawerBack").addEventListener("click", () => {
    drawerStack.pop();
    const prev = drawerStack[drawerStack.length - 1];
    if (prev) openDeep(prev, true); else closeDrawer();
    $("#drawerBack").hidden = drawerStack.length <= 1;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden && $("#zoomOverlay").hidden) closeDrawer(); });

  /* ---------- diagram zoom lightbox ---------- */
  const zoomOverlay = $("#zoomOverlay");
  const zoomStage = $("#zoomStage");
  const zoomInner = $("#zoomInner");
  const zoomLevel = $("#zoomLevel");
  // baseW/baseH = intrinsic (viewBox) px size of the SVG. We scale the SVG element
  // itself (vector reflow → always crisp) and use transform only to translate (pan).
  let zState = { scale: 1, x: 0, y: 0, baseW: 0, baseH: 0 };

  function applyZoom() {
    const svg = zoomInner.querySelector("svg");
    if (svg && zState.baseW) {
      svg.style.width = (zState.baseW * zState.scale) + "px";
      svg.style.height = (zState.baseH * zState.scale) + "px";
    }
    zoomInner.style.transform = "translate(" + zState.x + "px," + zState.y + "px)";
    zoomLevel.textContent = Math.round(zState.scale * 100) + "%";
  }
  function fitZoom() {
    if (!zState.baseW) { applyZoom(); return; }
    const stb = zoomStage.getBoundingClientRect();
    const scale = Math.min((stb.width - 48) / zState.baseW, (stb.height - 48) / zState.baseH, 2) || 1;
    zState.scale = scale > 0 ? scale : 1;
    zState.x = Math.max(0, (stb.width - zState.baseW * zState.scale) / 2);
    zState.y = Math.max(0, (stb.height - zState.baseH * zState.scale) / 2);
    applyZoom();
  }
  function intrinsicSize(svg) {
    // Prefer the viewBox (true vector extent); fall back to attributes / bbox.
    if (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) {
      return { w: svg.viewBox.baseVal.width, h: svg.viewBox.baseVal.height };
    }
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2]) return { w: vb[2], h: vb[3] };
    try { const b = svg.getBBox(); if (b.width) return { w: b.width, h: b.height }; } catch (e) {}
    const r = svg.getBoundingClientRect();
    return { w: r.width || 800, h: r.height || 600 };
  }
  function openZoom(svg) {
    zoomInner.innerHTML = "";
    const clone = svg.cloneNode(true);
    // Drop mermaid's max-width cap so the SVG can grow to whatever we set.
    clone.style.maxWidth = "none";
    clone.removeAttribute("width");
    clone.removeAttribute("height");
    clone.setAttribute("preserveAspectRatio", "xMidYMid meet");
    zoomInner.appendChild(clone);
    zoomOverlay.hidden = false;
    const { w, h } = intrinsicSize(svg);
    zState = { scale: 1, x: 0, y: 0, baseW: w, baseH: h };
    requestAnimationFrame(fitZoom);
  }
  function closeZoom() { zoomOverlay.hidden = true; zoomInner.innerHTML = ""; }

  zoomOverlay.querySelector(".zoom-toolbar").addEventListener("click", (e) => {
    const act = e.target.closest("[data-zoom]");
    if (!act) return;
    const a = act.dataset.zoom;
    if (a === "close") return closeZoom();
    if (a === "reset") return fitZoom();
    const factor = a === "in" ? 1.25 : 0.8;
    zoomAt(zoomStage.clientWidth / 2, zoomStage.clientHeight / 2, factor);
  });
  function zoomAt(cx, cy, factor) {
    const newScale = Math.max(0.1, Math.min(8, zState.scale * factor));
    const k = newScale / zState.scale;
    zState.x = cx - (cx - zState.x) * k;
    zState.y = cy - (cy - zState.y) * k;
    zState.scale = newScale;
    applyZoom();
  }
  zoomStage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = zoomStage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 0.89);
  }, { passive: false });
  let dragging = false, lastX = 0, lastY = 0;
  zoomStage.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; zoomStage.classList.add("grabbing"); zoomStage.setPointerCapture(e.pointerId); });
  zoomStage.addEventListener("pointermove", (e) => { if (!dragging) return; zState.x += e.clientX - lastX; zState.y += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; applyZoom(); });
  zoomStage.addEventListener("pointerup", () => { dragging = false; zoomStage.classList.remove("grabbing"); });
  zoomStage.addEventListener("dblclick", fitZoom);
  document.addEventListener("keydown", (e) => {
    if (zoomOverlay.hidden) return;
    if (e.key === "Escape") closeZoom();
    else if (e.key === "+" || e.key === "=") zoomAt(zoomStage.clientWidth / 2, zoomStage.clientHeight / 2, 1.25);
    else if (e.key === "-") zoomAt(zoomStage.clientWidth / 2, zoomStage.clientHeight / 2, 0.8);
    else if (e.key === "0") fitZoom();
  });

  /* ---------- search ---------- */
  const searchInput = $("#search");
  const searchResults = $("#searchResults");
  let searchIndex = null;
  async function buildSearchIndex() {
    if (searchIndex) return searchIndex;
    searchIndex = [];
    for (const [route, cfg] of Object.entries(ROUTES)) {
      try {
        const md = await fetchMd(cfg.file);
        md.split("\n").forEach((line) => {
          const m = line.match(/^(#{2,3})\s+(.*)/);
          if (m) searchIndex.push({ route, level: m[1].length, text: m[2].replace(/[*`]/g, "").trim(), id: slugify(m[2]) });
        });
      } catch (e) {}
    }
    return searchIndex;
  }
  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 140);
  });
  async function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchResults.textContent = ""; buildToc(parseHash().route); return; }
    const idx = await buildSearchIndex();
    const hits = idx.filter((e) => e.text.toLowerCase().includes(q)).slice(0, 30);
    tocEl.innerHTML = "";
    searchResults.textContent = hits.length + " result" + (hits.length === 1 ? "" : "s");
    hits.forEach((h) => {
      const a = document.createElement("a");
      a.className = h.level === 3 ? "h3" : "";
      a.textContent = h.text;
      a.title = ROUTES[h.route].title;
      a.href = "#/" + h.route + "#" + h.id;
      a.addEventListener("click", () => closeSidebarMobile());
      tocEl.appendChild(a);
    });
  }

  /* ---------- mobile sidebar ---------- */
  const sidebar = $("#sidebar");
  $("#menuBtn").addEventListener("click", () => sidebar.classList.toggle("open"));
  function closeSidebarMobile() { sidebar.classList.remove("open"); }
  document.querySelectorAll(".nav-link").forEach((a) => a.addEventListener("click", closeSidebarMobile));

  /* ---------- boot ---------- */
  window.addEventListener("hashchange", () => renderRoute(false));
  if (!location.hash) location.replace("#/" + DEFAULT_ROUTE);
  renderRoute(false);
})();
