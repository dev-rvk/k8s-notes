# SETUP.md — Kubernetes Deployment (ArgoCD + Helm, GitOps)

> **This is the ops repo.** It deploys a Go backend, a React/Vite frontend, and three
> off-the-shelf services (YugabyteDB, Kafka, Redis) to a Kubernetes cluster via ArgoCD.
> Git is the single source of truth — every change to the cluster is a commit.

**Mental model:**
`git push → ArgoCD root → child Applications → helm template → Kubernetes objects → ReplicaSets → Pods`

> **Stack-evolution note (read first).** This document keeps the original **YugabyteDB + Kafka + Redis** stack as a worked example of the *pattern* (multi-source, sync waves, single-Ingress ownership). The capstone in **§3.3 CS3 has since evolved** to **PostgreSQL via the [CloudNativePG operator](deep:p3-cloudnativepg) + Kafka via the [Strimzi operator](deep:p3-strimzi) + Redis** — i.e. *operators + CRs* instead of stateful upstream charts. The GitOps mechanics here are identical (only the wave-0 "operator" vs wave-0 "stateful chart" entries differ); treat CS3 as the current target and this Yugabyte layout as the equivalent earlier shape. The two are reconciled, not contradictory.

---

# ✅ Confirmed & Finalized

## Deployment model

GitOps via ArgoCD using the [**app-of-apps**](deep:p3-app-of-apps) pattern. One `root` Application is applied by hand
once; it reads the `apps/` folder (`directory.recurse: true`) and creates one child `Application` per component. ArgoCD
renders each chart with [**`helm template`**](deep:p3-helm-template-vs-install) (not `helm install`) and reconciles the result against
the cluster. There is no Helm release living in the cluster, and `helm list` shows nothing — ArgoCD
owns state, not Helm (so rollback is a Git revert, not `helm rollback`). For *templated multiplicity* — the same app across many clusters, or a preview env per PR — you'd graduate to an [**ApplicationSet**](deep:p3-applicationset) generator rather than hand-writing more child files.

## Component categories

| Category | Source | Config |
|---|---|---|
| Your services (backend, frontend) | one [generic chart](deep:p3-generic-chart) `charts/app` | per-app file in `values/` |
| Off-the-shelf infra (YugabyteDB, Kafka, Redis) | upstream community charts, **version-pinned** (§3.3 CS3 now prefers operators: [CloudNativePG](deep:p3-cloudnativepg), [Strimzi](deep:p3-strimzi)) | `values/<name>.yaml` |
| Routing | dedicated `charts/ingress` chart | `values/ingress.yaml` |

## Ops repo structure

```text
my-platform/                      # the ops / GitOps repo (this repo)
├── apps/                         # ArgoCD Application manifests (plain YAML)
│   ├── root.yaml                 # app-of-apps — apply this ONE by hand, once
│   ├── yugabyte.yaml             # sync-wave 0
│   ├── redis.yaml                # sync-wave 0
│   ├── kafka.yaml                # sync-wave 0
│   ├── backend.yaml              # sync-wave 1
│   ├── frontend.yaml             # sync-wave 2
│   └── ingress.yaml              # sync-wave 3
│
├── charts/
│   ├── app/                      # ONE generic chart, reused by ALL your services + future projects
│   │   ├── Chart.yaml
│   │   ├── values.yaml           # safe defaults + every toggle (ingress.enabled, probes, command, volumes…)
│   │   └── templates/
│   │       ├── _helpers.tpl
│   │       ├── deployment.yaml
│   │       ├── service.yaml
│   │       ├── configmap.yaml
│   │       └── ingress.yaml      # only renders if .Values.ingress.enabled (off in this setup)
│   └── ingress/                  # routing chart — the SOLE owner of the shared Ingress
│       ├── Chart.yaml
│       ├── values.yaml
│       └── templates/
│           └── ingress.yaml      #  / → frontend Service,  /api → backend Service
│
└── values/                       # config ONLY — no templates here
    ├── backend.yaml              # consumed by charts/app
    ├── frontend.yaml             # consumed by charts/app
    ├── ingress.yaml              # consumed by charts/ingress
    ├── yugabyte.yaml             # override values for the upstream chart
    ├── redis.yaml
    └── kafka.yaml
```

> The generic `charts/app` *can* render its own per-host Ingress (handy for other projects), but in
> this setup routing is centralised in `charts/ingress`, so `backend.yaml` and `frontend.yaml` set
> `ingress.enabled: false`.

## Flow diagram

```mermaid
flowchart TD
  KUBECTL(["kubectl apply -f apps/root.yaml<br/>run once"]):::action

  subgraph ARGOCD["ArgoCD - control plane , app-of-apps"]
    ROOTAPP["Application: root<br/>source: apps/ , recurse"]:::app
    YBAPP["Application: yugabyte<br/>sync-wave 0"]:::app
    REDISAPP["Application: redis<br/>sync-wave 0"]:::app
    KAFKAAPP["Application: kafka<br/>sync-wave 0"]:::app
    BEAPP["Application: backend<br/>sync-wave 1"]:::app
    FEAPP["Application: frontend<br/>sync-wave 2"]:::app
    INGAPP["Application: ingress<br/>sync-wave 3"]:::app
  end

  KUBECTL -->|creates| ROOTAPP
  ROOTAPP -->|creates| YBAPP
  ROOTAPP -->|creates| REDISAPP
  ROOTAPP -->|creates| KAFKAAPP
  ROOTAPP -->|creates| BEAPP
  ROOTAPP -->|creates| FEAPP
  ROOTAPP -->|creates| INGAPP

  subgraph GIT["Git: charts/ and values/ , this repo"]
    APPCHART["charts/app/<br/>generic chart , reused<br/>Chart.yaml , values.yaml , templates/"]:::gitfile
    INGCHART["charts/ingress/<br/>routing chart"]:::gitfile
    BEVALS["values/backend.yaml"]:::gitfile
    FEVALS["values/frontend.yaml"]:::gitfile
    INGVALS["values/ingress.yaml"]:::gitfile
  end

  BEAPP -->|helm template| BERENDER{{"render: backend"}}:::render
  FEAPP -->|helm template| FERENDER{{"render: frontend"}}:::render
  INGAPP -->|helm template| INGRENDER{{"render: ingress"}}:::render

  APPCHART --> BERENDER
  BEVALS --> BERENDER
  APPCHART --> FERENDER
  FEVALS --> FERENDER
  INGCHART --> INGRENDER
  INGVALS --> INGRENDER

  BERENDER -->|produces| BECM["ConfigMap: backend-config"]:::obj
  BERENDER -->|produces| BEDEP["Deployment: backend"]:::obj
  BERENDER -->|produces| BESVC["Service: backend"]:::obj
  BEDEP -->|controller creates| BERS["ReplicaSet: backend"]:::obj
  BERS -->|creates| BEPOD["Pods: Go on :8080"]:::pod
  BECM -.->|env via envFrom and checksum rolls pods| BEPOD
  BESVC -.->|load balances to| BEPOD

  FERENDER -->|produces| FECM["ConfigMap: frontend-config"]:::obj
  FERENDER -->|produces| FEDEP["Deployment: frontend"]:::obj
  FERENDER -->|produces| FESVC["Service: frontend"]:::obj
  FEDEP -->|controller creates| FERS["ReplicaSet: frontend"]:::obj
  FERS -->|creates| FEPOD["Pods: nginx + built Vite assets"]:::pod
  FECM -.->|entrypoint writes runtime config at startup| FEPOD
  FESVC -.->|load balances to| FEPOD

  INGRENDER -->|produces| INGRESS["Ingress: single owner<br/>/ to frontend , /api to backend"]:::obj
  INGRESS -.->|serves UI| FESVC
  INGRESS -.->|routes api to| BESVC

  REDISAPP -->|renders| REDISOUT["stock redis chart , upstream<br/>values: values/redis.yaml<br/>StatefulSet , Service , Secret"]:::stock
  KAFKAAPP -->|renders| KAFKAOUT["stock kafka chart , upstream<br/>values: values/kafka.yaml<br/>StatefulSet , Services"]:::stock
  YBAPP -->|renders| YBOUT["stock yugabyte chart , upstream<br/>values: values/yugabyte.yaml<br/>StatefulSets , Services"]:::stock

  classDef action fill:#fed7aa,stroke:#ea580c,color:#7c2d12,stroke-width:1.5px;
  classDef app fill:#bfdbfe,stroke:#2563eb,color:#1e3a5f,stroke-width:1.5px;
  classDef gitfile fill:#ddd6fe,stroke:#7c3aed,color:#3b0764,stroke-width:1.5px;
  classDef render fill:#a7f3d0,stroke:#059669,color:#064e3b,stroke-width:1.5px;
  classDef obj fill:#e2e8f0,stroke:#475569,color:#0f172a,stroke-width:1.5px;
  classDef pod fill:#fde68a,stroke:#ca8a04,color:#713f12,stroke-width:1.5px;
  classDef stock fill:#e2e8f0,stroke:#94a3b8,color:#334155,stroke-width:1.5px,stroke-dasharray: 4 3;
```

**Legend:** purple = files in Git · blue = ArgoCD Applications · green = the `helm template` render step ·
grey = rendered Kubernetes objects · yellow = running Pods · dashed grey = collapsed stock services.
Solid arrows = "creates / produces"; dotted arrows = runtime relationships.

## Setup steps

1. Create this repo with the structure above.
2. Build the generic chart `charts/app` — Deployment, Service, ConfigMap, and an optional gated Ingress. Keep it generic so it is reusable across services and future projects.
3. Build `charts/ingress` — the single Ingress that routes `/` → frontend and `/api` → backend.
4. Write `values/<component>.yaml` for everything. For the three upstream charts, **pin the chart version** and **repoint container images off the [deprecated Bitnami catalog](deep:p3-bitnami-sourcing)** (see rationale below). Remember: maps deep-merge but [lists replace wholesale](deep:p3-values-precedence), and override **transitive subchart** images too.
5. Write one ArgoCD `Application` per component in `apps/`, each carrying a [`sync-wave`](deep:p3-sync-waves) annotation. Use [**multi-source**](deep:p3-argocd-multisource) so the chart and its values file (which live in different folders of this repo) resolve cleanly via `$values/...`.
6. Write `apps/root.yaml` (app-of-apps) pointing at `apps/` with `directory.recurse: true`.
7. In ArgoCD: register this Git repo (Settings → Repositories), plus any upstream Helm repos / OCI registries you reference.
8. Bootstrap once: `kubectl apply -f apps/root.yaml`. ArgoCD creates everything in wave order.
9. Verify in the ArgoCD UI (each app **Synced + Healthy**). From here on, change anything by editing Git and pushing.

## Canonical ArgoCD Application (multi-source + sync wave)

Every one of your services is this same file with a different `name`, `sync-wave`, and values path.

```yaml
# apps/backend.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: backend
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"        # infra is 0, frontend 2, ingress 3
spec:
  project: default
  sources:
    - repoURL: https://github.com/you/my-platform.git
      targetRevision: main
      path: charts/app                        # the ONE generic chart
      helm:
        valueFiles:
          - $values/values/backend.yaml       # ← resolved from the ref source below
    - repoURL: https://github.com/you/my-platform.git
      targetRevision: main
      ref: values                             # names this source "values"; no path -> renders NOTHING, just mounts the repo as $values
  destination:
    server: https://kubernetes.default.svc
    namespace: myapp
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions:
      - CreateNamespace=true
```

The generic chart renders its Ingress only when asked, so the same chart serves apps with and without one:

```yaml
# charts/app/templates/ingress.yaml
{{- if .Values.ingress.enabled }}            # false for backend/frontend in this setup
apiVersion: networking.k8s.io/v1
kind: Ingress
# ...
{{- end }}
```

## Finalized decisions

- **One [generic chart](deep:p3-generic-chart), per-app values.** `charts/app` is reused by every service and copy-pasted into future projects; each app is just a values file. Build chart-per-entity only when an entity genuinely needs different *templates*; share template *logic* across structurally-different charts via a [library chart](deep:p3-library-chart) (`type: library`).
- **[Multi-source Applications](deep:p3-argocd-multisource)** (`$values` ref) so the chart and its values file can live in different folders of the same repo. The ref source renders nothing; `valueFiles` apply in order (last wins); on duplicate *resources* across manifest-producing sources, **last source wins** with a `RepeatedResourceWarning`. (Alternative: inline the config under `helm.valuesObject`, or `values: |` on older ArgoCD, and drop the `values/` files.)
- **One host = one Ingress = one owner.** Routing lives in `charts/ingress`; app charts set `ingress.enabled: false`. Never let two charts emit an Ingress for the same host — the failure is at runtime, not in Git ([why](deep:p3-ingress-ownership)).
- **Deploy order via [sync waves](deep:p3-sync-waves):** operators `-1` → stateful infra (yugabyte/redis/kafka) `0` → backend `1` → frontend `2` → ingress `3`. ArgoCD waits for every resource in a wave to be **Healthy** before the next — *but* a CR with no registered health check reports Healthy instantly, so don't treat a wave as a runtime guarantee. Waves order within a phase; Helm [hooks](deep:p3-helm-hooks) map to the coarser `PreSync`/`Sync`/`PostSync` phases.
- **Design for convergence, not hard ordering.** Readiness probes + app-level retry/backoff; transient `CrashLoopBackOff` self-heals. Use an `initContainer` only for a true hard gate (e.g. DB migration). Waves order the *deploy*, never the *runtime*.
- **Pin all upstream chart versions** and override image registries away from the [deprecated Bitnami public catalog](deep:p3-bitnami-sourcing) (frozen `bitnamilegacy`; off-ramps: [Chainguard](deep:p3-chainguard) Wolfi forks, bitcompat, operators).
- **Config flow:** backend reads its ConfigMap via `envFrom`, with a `checksum/config` annotation that rolls pods on config change. Frontend reads [runtime config](deep:p3-vite-runtime-config) written by its container entrypoint — because Vite bakes `VITE_*` at build time — or avoids the problem entirely with same-origin `/api` routing.
- **Secrets:** never commit plaintext. Use [**Sealed Secrets**](deep:p3-sealed-vs-external-secrets) (encrypted blobs safe for Git, controller decrypts) or the **External Secrets Operator** (Git holds only a reference; ESO pulls from Vault / a cloud secret manager). Operators like CloudNativePG/Strimzi publish their own credential Secrets.

---

# 📝 Essence of the Discussion (background & rationale)

The reasoning behind the decisions above, distilled.

- **ArgoCD is not `helm install`.** It runs [`helm template`](deep:p3-helm-template-vs-install) to render plain manifests, then applies and continuously reconciles them. Consequence: no Helm release in the cluster, `helm list` is empty, ArgoCD is the source of truth, rollback is a Git revert. Most Helm [hooks](deep:p3-helm-hooks) still map onto ArgoCD sync phases — but `helm template` does **not** run them at render, and [`lookup`](deep:p3-helm-template-engine) returns empty, so `lookup`-based secret generation misbehaves under ArgoCD.

- **You don't "find" a chart for your own code.** Third-party charts exist for off-the-shelf software only. For your Go/React code you template it yourself (`helm create`, trimmed) or use a generic app chart — which is why we landed on one shared `charts/app`.

- **The [Bitnami sourcing](deep:p3-bitnami-sourcing) change matters.** The public Bitnami catalog was deprecated in 2025: images were frozen and moved to an unpatched `bitnamilegacy` repo, and the maintained, hardened catalog now sits behind the paid "Bitnami Secure" subscription. So "Kafka/Redis charts are already available" is true, but the safe sources changed. For this stack: official **`yugabytedb/yugabyte`** chart; [**Strimzi operator**](deep:p3-strimzi) for Kafka; [**Chainguard's Bitnami fork**](deep:p3-chainguard) or a Redis operator for Redis; and per §3.3 CS3, **[CloudNativePG](deep:p3-cloudnativepg)** where Postgres replaces Yugabyte. Pin versions and override image references regardless — including transitive subchart images (the Bitnami `common` library chart is pulled in by most Bitnami charts).

- **Choosing which values to override.** `helm show values <repo>/<chart> --version X.Y.Z` is the authoritative source (the Artifact Hub page and README are summaries). Override only the subset that differs for you — typically `replicaCount`, `resources`, `persistence` (size/storageClass), auth, and the app-specific knobs — not the whole file. Preview with `helm template … -f your-values.yaml` before ArgoCD sees it.

- **Ingress ownership / "merge conflicts."** Two charts emitting an Ingress is **not** a Git merge conflict (different files in different charts). The real failure is at runtime: same name + namespace → both Applications claim the object and fight (permanent out-of-sync flapping); different names → the controller merges rules per host, which is fine for non-overlapping paths but flaky for overlapping paths or host-level settings (TLS, annotations). Hence: exactly one owner per host.

- **[Ordering & runtime readiness](deep:p3-sync-waves) are two different things.** Kubernetes has no `depends_on` between Deployments. Sync waves order the *deploy*, but a pod can still start while a dependency restarts later — and a CR without a health check is reported Healthy before it's truly live, so the next wave may start early. The backend will boot whether or not Kafka is reachable; the right outcome is retry/backoff (or crash-and-restart until it answers). The **Ingress is not a startup dependency** — it just routes, returning 503 until backing pods are ready.

- **The [Vite gotcha](deep:p3-vite-runtime-config).** `import.meta.env.VITE_*` is baked into the bundle at **build time**, so setting an env var on a running frontend pod does nothing. A "configurable" SPA needs either runtime injection (entrypoint runs `envsubst` to write a `config.js` the app reads via `window.__ENV__`, served *before* the bundle and not long-cached) or — simpler — same-origin `/api` routing via the Ingress so no backend URL is baked at all. This is also why the frontend's config story is an *image* concern, not a chart concern.

- **Why a [generic chart](deep:p3-generic-chart) works for both backend and frontend.** The only frontend-specific behaviour (the `config.js` entrypoint) lives in the frontend image; to the chart, the frontend is just another container reading env from a ConfigMap, exactly like the backend. So one chart covers both, and the per-app differences (image, ports, env, whether an Ingress renders) are all values — every such feature behind an `if`/`with` gate. Graduate to a Helm [**library chart**](deep:p3-library-chart) (`type: library`) only when apps need genuinely different templates, not just different values.
