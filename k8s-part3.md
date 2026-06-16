# Kubernetes Notes — Part 3: Helm + Repo Structure + Case Studies

> Same format. Case studies are **diagram-first → glue code → cross-links** — they reuse the constructs from Parts 1–2 by reference (`§1.6`, `§2.1`, …) instead of re-explaining. Current as of 2026.

**Contents:** 3.1 Helm fundamentals · 3.2 Ops-repo structure · 3.3 Case studies (CS1–CS4) · 3.4 Interview questions

---

## 3.1 Helm fundamentals

**Why:** without Helm you copy-paste near-identical YAML per app and per environment. Helm gives **templating + packaging + release tracking** — one chart, many values. **What:** a chart is a parameterized package; `values` fill the blanks; the engine renders plain manifests.

```mermaid
flowchart LR
  CHART["chart/<br/>templates + Chart.yaml"] --> H["helm engine"]
  VALUES["values.yaml + -f files + --set"] --> H
  H -->|renders| MAN["plain Kubernetes manifests"]
  MAN --> CL["apply to cluster"]
```

**Chart anatomy:**

| File / dir | Purpose |
|---|---|
| `Chart.yaml` | metadata: `name`, `version` (chart), `appVersion` (app), `dependencies` |
| `values.yaml` | default values — the override surface |
| `templates/` | Go-templated manifests |
| `templates/_helpers.tpl` | reusable named snippets (names, labels) |
| `templates/NOTES.txt` | post-install message |
| `charts/` | vendored subchart dependencies |

**Values precedence (low → high, last wins):**

```mermaid
flowchart TB
  D["chart default values.yaml"] --> P["parent values , for subcharts"]
  P --> F["-f file1 then -f file2"]
  F --> S["--set key=value"]
  S --> WIN["effective value"]
```

**Commands:**

| Command | Does |
|---|---|
| `helm template` | render to stdout, no cluster — **what ArgoCD uses** (§2.6) |
| `helm install` | render + apply + record a **Release** |
| `helm upgrade` / `rollback` | new revision / revert |
| `helm show values <chart>` | dump default values — **authoritative** source for overrides |
| `helm list` | list Releases — **empty under ArgoCD** |

**Bitnami sourcing caveat (read before picking infra charts):** the public `docker.io/bitnami` images moved to a frozen `docker.io/bitnamilegacy` repo (no updates); the packaged charts at `docker.io/bitnamicharts` still exist but are unmaintained and **need image-repo overrides**; the hardened catalog is now the paid Bitnami Secure subscription. Free off-ramps: **Chainguard** first-party charts (drop-in forks), **bitcompat** community forks, official project charts, or operators. **Always pin chart versions** and override image references.

**Gotchas:** `version` (chart) ≠ `appVersion` (your app). Subcharts share the parent's `values` namespace under their name. **Library charts** (`type: library`) ship only reusable templates, no rendered objects — the basis of the generic chart in §3.3. Preview anything with `helm template ... | less` before it hits a cluster.

---

## 3.2 Ops-repo structure (GitOps)

The finalized layout: **one generic chart** for your services + **a routing chart** for the single Ingress + **values** per component + **ArgoCD Applications** in `apps/`.

```text
my-platform/
├── apps/                 # ArgoCD Applications (root + one per component, sync-wave annotated)
├── charts/
│   ├── app/              # ONE generic chart, reused by every service (and future projects)
│   └── ingress/          # routing chart — sole owner of the shared Ingress (§1.8)
└── values/               # config only: backend.yaml, frontend.yaml, redis.yaml, …
```

```mermaid
flowchart TB
  PUSH["git push"] --> ROOT["ArgoCD root app , app-of-apps §2.6"]
  ROOT --> CHILD["child Applications , one per component"]
  CHILD --> REND["helm template per app"]
  REND --> OBJ["Kubernetes objects"]
  OBJ --> RS["ReplicaSets / StatefulSets §1.5 §2.4"]
  RS --> PODS["Pods §1.3"]
```

**Wiring:** each Application uses **multi-source** (§2.6) — the chart from one source, its `values/<svc>.yaml` from a `ref` source. Ordering via **sync waves** (§2.6): operators → stateful infra → backend → frontend → ingress. See full SETUP.md for the canonical Application manifest.

**Gotchas:** adding a service = new `values/<svc>.yaml` + new `apps/<svc>.yaml`; the generic chart is untouched. Only externally-exposed HTTP services touch the ingress chart (§1.8).

---

## 3.3 Case studies

### CS1 — Stateless web app (frontend + backend + config + ingress + autoscale)

```mermaid
flowchart TB
  U["browser"] --> ING["Ingress §1.8<br/>/ to frontend , /api to backend"]
  ING -->|to frontend| FSVC["Service: frontend §1.7"] --> FPOD["frontend pods"]
  ING -->|to backend| BSVC["Service: backend §1.7"] --> BPOD["backend pods §1.6"]
  CM["ConfigMap §2.1"] -.->|envFrom| BPOD
  HPA["HPA §2.3.3"] -.->|scales| BPOD
```

**What's happening:** the generic chart (§3.2) renders a Deployment (§1.6) + Service (§1.7) per app; config rides in via a ConfigMap consumed with `envFrom` + a checksum annotation (§2.1); the shared ingress chart owns routing (§1.8); an HPA scales the backend on CPU (§2.3.3), gated by readiness probes (§2.3.2). **Glue code** = just the values + the gated templates:

```yaml
# values/backend.yaml  (fed to charts/app)
image: { repository: registry.example.com/myorg/backend, tag: "1.4.0" }
service: { targetPort: 8080 }
config:                       # → ConfigMap, injected via envFrom (§2.1)
  KAFKA_BROKERS: kafka-bootstrap:9092
  REDIS_URL: redis://redis-master:6379
ingress: { enabled: false }   # routing lives in charts/ingress (§1.8)
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
readinessProbe: { httpGet: { path: /healthz, port: 8080 } }  # §2.3.2
```

```yaml
# charts/app/templates/hpa.yaml  (gated, so the chart stays generic)
{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: {{ include "app.fullname" . }} }
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }} } }
{{- end }}
```

```yaml
# charts/ingress/templates/ingress.yaml  (the single owner, §1.8)
spec:
  rules:
    - host: app.example.com
      http:
        paths:
          - { path: /,    pathType: Prefix, backend: { service: { name: frontend, port: { number: 80 } } } }
          - { path: /api, pathType: Prefix, backend: { service: { name: backend,  port: { number: 80 } } } }
```

### CS2 — Stateful service (MongoDB, by hand, to see the primitives)

```mermaid
flowchart TB
  APP["app pods"] --> HSVC["Headless Service §1.7<br/>mongo-headless"]
  HSVC -.-> M0["mongo-0<br/>own PVC + Secret §2.2"]
  HSVC -.-> M1["mongo-1<br/>own PVC"]
  HSVC -.-> M2["mongo-2<br/>own PVC"]
  M0 <-->|replication| M1
  M1 <-->|replication| M2
```

**What's happening:** a StatefulSet (§2.4) gives stable names `mongo-0..2`, each with its **own** PVC (not shared) and stable DNS via a **headless** Service (§1.7); credentials come from a Secret (§2.2). **Glue code:**

```yaml
# headless Service — clusterIP: None gives per-pod DNS (§1.7)
apiVersion: v1
kind: Service
metadata: { name: mongo-headless }
spec: { clusterIP: None, selector: { app: mongo }, ports: [{ port: 27017 }] }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: mongo }
spec:
  serviceName: mongo-headless          # ties to the headless Service
  replicas: 3
  selector: { matchLabels: { app: mongo } }
  template:
    metadata: { labels: { app: mongo } }
    spec:
      containers:
        - name: mongo
          image: mongo:7
          ports: [{ containerPort: 27017 }]
          envFrom: [{ secretRef: { name: mongo-creds } }]   # §2.2
          volumeMounts: [{ name: data, mountPath: /data/db }]
  volumeClaimTemplates:                # one PVC PER pod (§2.4)
    - metadata: { name: data }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 20Gi } } }
```

> In production you'd usually let an **operator** run Mongo (failover, backups) — which is exactly what CS3 does for Postgres.

### CS3 — Capstone: full app via ArgoCD (operators + app-of-apps + waves)

Replacing the earlier Yugabyte stack: **Go backend + Vite frontend + PostgreSQL (operator) + Kafka (Strimzi operator) + Redis**.

```mermaid
flowchart TB
  ROOT["ArgoCD root , app-of-apps §2.6"] --> W0
  subgraph W0["wave 0 : operators"]
    PGOP["CloudNativePG operator §2.5"]
    KOP["Strimzi Kafka operator §2.5"]
  end
  subgraph W1["wave 1 : stateful + infra"]
    PG["Postgres Cluster CR"]
    KAFKA["Kafka CR"]
    REDIS["Redis chart"]
  end
  subgraph W2["wave 2 : backend"]
    BE["backend , generic chart + values §3.2"]
  end
  subgraph W3["wave 3 : frontend + ingress"]
    FE["frontend"]
    ING["ingress chart §1.8"]
  end
  W0 --> W1 --> W2 --> W3
  PGOP -.->|manages| PG
  KOP -.->|manages| KAFKA
  BE -.->|reads| PG
  BE -.->|reads| KAFKA
  BE -.->|reads| REDIS
```

**What's happening:** operators install first (wave 0) so their CRDs exist; their CRs (a Postgres `Cluster`, a `Kafka`) come up in wave 1 alongside Redis; then backend, then frontend + ingress (§2.6 waves). The backend reads everything over ClusterIP DNS (§1.7) — no ingress on the data services (§1.8 gotcha). **Glue code** = the ArgoCD Applications and the CRs:

```yaml
# apps/postgres-operator.yaml — wave 0 (CRDs must exist before the CR)
metadata:
  name: postgres-operator
  annotations: { argocd.argoproj.io/sync-wave: "0" }
spec:
  source: { repoURL: https://cloudnative-pg.github.io/charts, chart: cloudnative-pg, targetRevision: 0.x.x }
  destination: { server: https://kubernetes.default.svc, namespace: cnpg-system }
  syncPolicy: { automated: { prune: true, selfHeal: true }, syncOptions: [CreateNamespace=true] }
---
# apps/postgres.yaml — wave 1 (the CR the operator reconciles, §2.5)
metadata:
  name: postgres
  annotations: { argocd.argoproj.io/sync-wave: "1" }
# source points at a tiny chart/manifest containing:
#   apiVersion: postgresql.cnpg.io/v1
#   kind: Cluster
#   spec: { instances: 3, storage: { size: 20Gi } }
---
# apps/backend.yaml — wave 2, generic chart + its values (multi-source, §2.6 / §3.2)
metadata:
  name: backend
  annotations: { argocd.argoproj.io/sync-wave: "2" }
spec:
  sources:
    - { repoURL: https://github.com/you/my-platform.git, targetRevision: main, path: charts/app,
        helm: { valueFiles: ["$values/values/backend.yaml"] } }
    - { repoURL: https://github.com/you/my-platform.git, targetRevision: main, ref: values }
```

Backend config/secrets reuse CS1's pattern (ConfigMap §2.1 + Secret §2.2); Postgres credentials are published by the operator as a Secret the backend mounts.

### CS4 — Async worker (Kafka consumer, autoscaled on lag)

```mermaid
flowchart LR
  KAFKA["Kafka topic"] --> LAG{"consumer lag high?"}
  LAG -->|yes| UP["KEDA scales consumer up §2.3"]
  LAG -->|no| IDLE["scale toward zero"]
  UP --> C["consumer pods"]
  C -->|consume| KAFKA
```

**What's happening:** a plain Deployment (§1.6) of consumers, but scaled by **KEDA** on Kafka **lag** rather than CPU — the right signal for queue workers, and it can scale to zero when idle. **Glue code:**

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
spec:
  scaleTargetRef: { name: order-consumer }   # the Deployment
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
    - type: kafka
      metadata: { bootstrapServers: kafka-bootstrap:9092, consumerGroup: orders, topic: orders, lagThreshold: "100" }
```

---

## 3.4 Interview questions (synthesis)

**Q1. Why does ArgoCD use `helm template` not `helm install`, and how does that change debugging?**
ArgoCD renders + applies + reconciles itself, so there's no Helm Release (§3.1, §2.6) — `helm list` is empty and you debug with `argocd app manifests` / `kubectl`, not `helm get`. Hooks map to ArgoCD sync phases.

**Q2. You add a sixth microservice. What changes in the repo, what doesn't?**
Add `values/<svc>.yaml` + `apps/<svc>.yaml` (§3.2); the **generic chart is untouched** (§3.1 library/generic idea). Touch the ingress chart only if it's externally exposed (§1.8).

**Q3. An upstream chart's pods are stuck `ImagePullBackOff` after a redeploy. Diagnose.**
Likely the Bitnami legacy/deletion issue (§3.1): the chart references images that moved/were frozen. Fix by overriding the image repo (legacy mirror, Chainguard, bitcompat, or your own registry) and pinning versions. Ties to Pod image pull (§1.3).

**Q4. Generic chart vs per-app chart vs library chart — when each?**
Generic chart + values for many similar services (§3.2); per-app chart when one service needs unique *templates*; library chart (`type: library`, §3.1) when several charts share template logic but differ structurally.

**Q5. How do you make sure Postgres is ready before the backend that depends on it?**
Sync waves order the *apply* (operator → CR → backend, §2.6/§3.2/§2.5) and ArgoCD waits for Healthy between waves — but you still design the backend to **retry** (§2.3), because K8s has no hard runtime `depends_on` and a DB can blip later.

**Q6. Two values files set the same key — who wins? How does that mirror ArgoCD multi-source?**
Last `-f` wins (§3.1 precedence); analogously, in a multi-source Application the **last source wins** on duplicate resources (with a `RepeatedResourceWarning`, §2.6). Same "last writer wins" mental model.

**Q7. In CS1 the browser gets 502/404 on `/api`. Walk the layers.**
Ingress rule for `/api` missing/typo (§1.8) → or backend Service has no Ready endpoints because readiness is failing (§2.3.2, §1.7) → or `targetPort` mismatch → or the backend pods are crashlooping. Check rule → endpoints → pod.

**Q8. Why run Postgres via an operator+CR (CS3) but Mongo via a raw StatefulSet (CS2)?**
A StatefulSet (§2.4) gives identity + storage but no Day-2 logic; an operator (§2.5) adds failover, backups, and safe scaling encoded as a controller. CS2 shows the primitives; CS3 shows the production pattern.
