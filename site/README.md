# Kubernetes Notes — Deep Reference (static site)

A zero-build static website that renders the Kubernetes study notes with live
**mermaid diagrams** (click any diagram to zoom/pan in a lightbox),
syntax-highlighted **copy-friendly** code, full-text section search, and a
**drill-down drawer**: click any dashed concept link to open a deeper article
(its own diagrams included) in a side panel, with back-navigation.

**Diagram zoom:** hover a diagram → "⤢ zoom" (or click it) → scroll to zoom,
drag to pan, +/−/reset toolbar, double-click to fit, keyboard `+ − 0 Esc`.
**Copy code:** hover any code block → "Copy".

## Run it

The site loads `.md` files via `fetch()`, so it must be served over HTTP — it
will **not** work opened directly as a `file://` path. From this `site/` folder:

```bash
# Python (any 3.x)
python -m http.server 8099

# …or Node
npx serve -l 8099
```

Then open <http://localhost:8099>.

On Windows you can also just double-click **`serve.cmd`** (starts Python's
server and opens the browser).

## Structure

```
site/
├── index.html            # SPA shell
├── serve.cmd             # Windows one-click launcher
├── assets/
│   ├── app.js            # router, markdown→DOM, mermaid, drawer, search
│   └── styles.css        # dark/light theme
└── content/
    ├── part1.md          # Foundations
    ├── part2.md          # Config, Scaling, Extensibility, GitOps
    ├── part3.md          # Helm, Repo Structure, Case Studies
    ├── part4.md          # Reference Helm charts (Go backend + React SPA)
    ├── part5.md          # kubectl commands + sample apply-ready manifests
    ├── setup.md          # Production GitOps deployment guide
    └── deep/             # 79 drill-down articles (p1-…p5- prefixed)
```

## Authoring

- **Add a deep-dive:** create `content/deep/<slug>.md` (start with one `# H1`),
  then link to it from any doc with `[term](deep:<slug>)`. The slug is the
  filename — no manifest or rebuild needed.
- **Diagrams:** use fenced ```` ```mermaid ```` blocks. Keep every node label
  quoted (`A["text"]`) and avoid raw `()` / `:` inside labels — use commas and
  `<br/>` — to stay parser-safe.
- **Cross-refs** between sections use the `§X.Y` convention.

Originals live one level up (`../k8s-part1.md`, etc.) and are untouched; the
`content/` copies are the deepened, drill-down-linked versions the site serves.
