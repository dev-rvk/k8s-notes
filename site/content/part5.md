# Kubernetes Notes — Part 5: kubectl Commands & Sample Manifests

> **How to use:** §5.1 is a tight, copy-pasteable command reference (placeholder forms — substitute the `<…>`). §5.2 is a progression of complete, `kubectl apply -f`-ready manifests, primitive → higher-level, each followed by notes on only the *new* fields. Cross-refs use `§X.Y` into Parts 1–2; drill-downs use `deep:` links. Verified against **K8s 1.36** (`networking.k8s.io/v1` Ingress, `autoscaling/v2` HPA, `batch/v1` Job/CronJob, `policy/v1` PDB).

**Contents:** 5.1 Essential kubectl commands · 5.2 Sample manifests (Pod → … → NetworkPolicy)

---

## 5.1 Essential kubectl commands

> The ~20 you actually type daily. `<…>` = substitute; `[…]` = optional. Verbs operate on a **kind** (`pods`, `svc`, `deploy`, `rs`, `cm`, `secret`, `ing`, `sts`, `job`, `cronjob`, `hpa`, `netpol`, `pvc`, `ns`, `node`).

### Inspect / read

| Command | What it does | Key flags |
|---|---|---|
| `kubectl get <kind> [name]` | List objects (or one) | `-n`, `-A`, `-l`, `-o wide`, `-w`, `--show-labels` |
| `kubectl get pods -n <ns> -l <key>=<val> -o wide` | Filtered pod list with node/IP columns | `-l` ([selectors](deep:p5-selectors)), `-o wide` |
| `kubectl describe <kind> <name>` | Human-readable detail **+ Events** (the debugging gold) | `-n` |
| `kubectl logs <pod> [-c <ctr>] [-f] [--tail=N] [--previous]` | Container stdout/stderr | `-c`, `-f`, `--tail`, `--previous`, `--since` → [logs & debug](deep:p5-logs-debug) |
| `kubectl get <kind> <name> -o yaml` | Dump live object as YAML/JSON/jsonpath | `-o yaml\|json\|jsonpath=…` → [output formats](deep:p5-output-formats) |
| `kubectl get events -n <ns> --sort-by=.lastTimestamp` | Recent cluster events, chronological | `--sort-by`, `-A` |
| `kubectl top pod\|node` | Live CPU/memory (needs metrics-server) | `-n`, `--containers` |

### Run / change

| Command | What it does | Key flags |
|---|---|---|
| `kubectl apply -f <file\|dir\|->` | Declaratively create/update from manifest(s) | `-f`, `-k`, `--server-side` → [apply vs create](deep:p5-apply-vs-create) |
| `kubectl delete <kind> <name>` | Delete an object (`-f <file>` to delete what it defines) | `-f`, `-l`, `--grace-period`, `--now` |
| `kubectl scale deploy/<name> --replicas=<n>` | Set replica count (set `0` to "stop") | `--replicas`, `--current-replicas` |
| `kubectl rollout status\|undo\|restart deploy/<name>` | Watch / roll back / restart a rollout | `--revision`, `--to-revision` → [rollout](deep:p5-rollout) |
| `kubectl set image deploy/<name> <ctr>=<img:tag>` | Patch a container image (triggers rollout) | `--record` (deprecated) |
| `kubectl edit <kind> <name>` | Open live object in `$EDITOR`, apply on save | `-n` |
| `kubectl label <kind> <name> <key>=<val>` | Add/overwrite a label | `--overwrite`, `-l` → [labels/annotations](deep:p5-labels-annotations) |

### Interact / connect / debug

| Command | What it does | Key flags |
|---|---|---|
| `kubectl exec -it <pod> [-c <ctr>] -- <cmd>` | Run a command inside a container (`-- sh` for a shell) | `-it`, `-c` → [exec & port-forward](deep:p5-exec-portforward) |
| `kubectl port-forward <pod\|svc/name> <local>:<remote>` | Tunnel a local port to a pod/svc port | `-n`, `--address` |
| `kubectl cp <pod>:<path> <localpath>` | Copy files in/out of a container | `-c` |
| `kubectl debug <pod> -it --image=<img> [--target=<ctr>]` | Attach an **ephemeral** debug container (distroless-safe) | `--target`, `--copy-to` |
| `kubectl apply --dry-run=client -o yaml -f <file>` | Render/validate without sending to the server | `--dry-run=client\|server` → [dry-run & diff](deep:p5-dryrun-diff) |
| `kubectl diff -f <file>` | Show what `apply` *would* change vs the live cluster | `-f` → [dry-run & diff](deep:p5-dryrun-diff) |

> **There is no `kubectl stop`.** To "stop" a workload: **delete the Pod** (a controller — ReplicaSet/Deployment, §1.5/§1.6 — will recreate it), or **`kubectl scale deploy/<name> --replicas=0`** to keep the object but run zero Pods. Deleting a bare Pod (no controller) actually removes it; deleting a managed Pod just triggers reconciliation.

### What the cross-cutting flags do

```bash
-n, --namespace <ns>      # target one namespace (default: "default"); namespaced kinds only
-A, --all-namespaces      # span every namespace (read verbs)
-l, --selector <k=v,...>  # filter by labels: app=demo,tier!=cache,'env in (prod,stage)'  (§1.4)
-o <fmt>                  # wide | yaml | json | name | jsonpath='{...}' | go-template=...
-f <file|dir|->           # FILE input for apply/delete/create  (NOT "follow" here)
-f                        # with `logs`: FOLLOW (stream)  ← the -f overload: file vs follow
-it                       # -i (stdin) + -t (TTY): the combo you need for an interactive shell
--tail=<N>                # logs: last N lines only (default all for the current container)
--previous, -p            # logs: the PREVIOUS (crashed) container instance — find crash causes
--dry-run=client          # render+validate locally, send nothing; pair with -o yaml to scaffold
--dry-run=server          # run server-side admission/validation but don't persist
-w, --watch               # stream changes instead of a one-shot list
--context <name>          # pick a kubeconfig context (which CLUSTER+user) without switching default
```

**The `-f` trap, stated plainly:** with `apply`/`delete`/`create`, `-f` means **file**. With `logs` (and `attach`), `-f` means **follow**. Same letter, opposite jobs — context decides.

**Scaffold any manifest fast:**
```bash
kubectl create deploy demo --image=nginx --dry-run=client -o yaml > deploy.yaml   # generate, don't apply
kubectl run tmp --image=busybox -it --rm --restart=Never -- sh                    # throwaway debug pod
```

---

## 5.2 Sample manifests (`kubectl apply -f` ready)

> A progression from primitive to higher-level. Every example carries `app: demo` so the Services/selectors line up. Each block is valid on its own; later blocks only explain **new** fields. Apply a whole directory at once with `kubectl apply -f .`.

### 1. Pod (§1.3) — the primitive

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: demo-pod
  labels:
    app: demo
spec:
  containers:
    - name: web
      image: nginx:1.27
      ports:
        - containerPort: 80
      resources:
        requests: { cpu: 50m, memory: 64Mi }
        limits:   { cpu: 250m, memory: 128Mi }
  restartPolicy: Always
```
- `spec.containers[].image` / `ports[].containerPort` — the image and the port the process listens on (informational; doesn't open a firewall).
- `resources.requests` — what the **scheduler** reserves (§1.2); `limits` — the hard cap (CPU throttled, memory → OOMKill). See [QoS & eviction](deep:p2-qos-eviction).
- `restartPolicy` — `Always` (default for Pods/Deployments) | `OnFailure` | `Never`. Jobs use the latter two.
- **Don't run bare Pods in prod** (§1.3) — nothing reschedules them. Use a controller ↓.

### 2. ReplicaSet (§1.5) — keep N alive

```yaml
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: demo-rs
  labels:
    app: demo
spec:
  replicas: 3
  selector:
    matchLabels:
      app: demo
  template:
    metadata:
      labels:
        app: demo
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - containerPort: 80
```
- `spec.replicas` — desired Pod count the controller holds steady.
- `spec.selector.matchLabels` — which Pods this RS **owns**; **must match** `template.metadata.labels` or the API rejects it. Selector is immutable (§1.4).
- `spec.template` — the Pod blueprint (a Pod `spec` minus `apiVersion/kind`) stamped onto each replica.
- You rarely write this directly — a Deployment manages it for rollouts ↓.

### 3. Deployment (§1.6) — versioned rollouts

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
  labels:
    app: demo
spec:
  replicas: 3
  selector:
    matchLabels:
      app: demo
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: demo
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet: { path: /, port: 80 }
            initialDelaySeconds: 2
            periodSeconds: 5
```
- `strategy.type` — `RollingUpdate` (default) | `Recreate` (kill-all-then-start, causes downtime).
- `maxSurge` / `maxUnavailable` — rollout aggressiveness; `maxUnavailable: 0` = no capacity dip (needs surge headroom). See [rollout math](deep:p1-rolling-update-math).
- `readinessProbe` — gates each rollout step and Service membership (§1.7, [probes](deep:p2-probes)); without it the rollout "completes" instantly onto not-ready Pods.

### 4. Service — ClusterIP + NodePort (§1.7)

```yaml
apiVersion: v1
kind: Service
metadata:
  name: demo
spec:
  selector:
    app: demo
  ports:
    - name: http
      port: 80          # the Service's own port (what callers hit)
      targetPort: 80    # the container's port (where traffic lands)
---
apiVersion: v1
kind: Service
metadata:
  name: demo-nodeport
spec:
  type: NodePort
  selector:
    app: demo
  ports:
    - port: 80
      targetPort: 80
      nodePort: 30080   # optional; else auto-assigned from 30000–32767
```
- `spec.selector` — finds Pods by label; **must match** the Deployment's Pod labels or you get **zero endpoints** (the §1.9 trap). Note: a Service selector is plain key/value, *not* `matchLabels`.
- `port` vs `targetPort` vs `nodePort` — caller port vs container port vs node-exposed port. Full breakdown: [port vs targetPort vs nodePort](deep:p5-ports).
- `type` — omitted = `ClusterIP` (default); `NodePort` opens `NodeIP:nodePort` on every node. See [Service types](deep:p1-service-types).
- `---` separates multiple docs in one file — both apply together.

### 5. ConfigMap (§2.1) — non-secret config

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
data:
  APP_MODE: "production"
  app.properties: |
    log.level=info
    cache.ttl=300
```
- `data` — plain key/value strings; values can be inline files (note the `|` block scalar).
- Consumed as **env vars** (`envFrom`/`valueFrom`) or **mounted files** (`volumeMounts`). Mounted CMs update live; env vars are frozen at start — see [ConfigMap reload](deep:p2-configmap-reload) and the [checksum trick](deep:p2-checksum-annotation).

### 6. Secret (§2.2) — sensitive config

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: demo-secret
type: Opaque
stringData:
  DB_PASSWORD: "s3cr3t-pw"     # plaintext IN; kubectl base64-encodes it for you
data:
  API_TOKEN: YWJjMTIz          # already base64 ("abc123")
```
- `stringData` (write-only convenience, plaintext) vs `data` (base64). Both end up base64 in etcd. Details: [Secret data vs stringData](deep:p5-secret-encoding).
- `type` — `Opaque` (generic) | `kubernetes.io/dockerconfigjson` | `kubernetes.io/tls` | `kubernetes.io/service-account-token`.
- **Base64 is encoding, not encryption.** Enable [encryption at rest](deep:p2-encryption-at-rest); for GitOps use [sealed vs external secrets](deep:p2-sealed-secrets).

### 7. Ingress (§1.8) — L7 host/path routing

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo-ing
spec:
  ingressClassName: nginx
  rules:
    - host: demo.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: demo
                port:
                  number: 80
```
- `ingressClassName` — which installed controller handles this (replaces the old `kubernetes.io/ingress.class` annotation).
- `rules[].host` / `http.paths[].path` — L7 match; `pathType` is **required**: `Prefix` | `Exact` | `ImplementationSpecific`. See [pathType & rules](deep:p5-ingress-manifest).
- `backend.service.{name,port}` — the target Service (the L4 hop, §1.7). An Ingress with **no controller installed does nothing** (§1.8).

### 8. Stateful trio (§2.4) — PVC + StatefulSet + headless Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: demo-db          # headless governing Service
  labels:
    app: demo-db
spec:
  clusterIP: None        # headless: DNS returns Pod IPs, no VIP
  selector:
    app: demo-db
  ports:
    - port: 5432
      name: pg
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: demo-db
spec:
  serviceName: demo-db   # ties pods to the headless Service for stable DNS
  replicas: 2
  selector:
    matchLabels:
      app: demo-db
  template:
    metadata:
      labels:
        app: demo-db
    spec:
      containers:
        - name: pg
          image: postgres:16
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
```
- `clusterIP: None` — **headless** Service; pairs with `serviceName` to give stable per-Pod DNS `demo-db-0.demo-db.<ns>.svc.cluster.local` (§1.7, [StatefulSet](deep:p2-statefulset)).
- `serviceName` — the governing headless Service; **required** on a StatefulSet.
- `volumeClaimTemplates` — per-Pod PVCs minted from the template (each Pod gets its own `data-demo-db-0`, …); they **survive** Pod rescheduling and are **not** deleted with the StatefulSet by default.
- `accessModes` — `ReadWriteOnce` (one node) | `ReadWriteMany` | `ReadOnlyMany`. See [PV/PVC/StorageClass](deep:p2-pv-pvc-storageclass).

### 9. Job & CronJob (`batch/v1`)

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: demo-job
spec:
  backoffLimit: 4
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: task
          image: busybox:1.36
          command: ["sh", "-c", "echo processing && sleep 5"]
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: demo-cron
spec:
  schedule: "*/5 * * * *"          # min hour dom month dow
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: task
              image: busybox:1.36
              command: ["date"]
```
- `backoffLimit` — retries before the Job is marked Failed.
- `restartPolicy` — Jobs require `OnFailure` or `Never` (not `Always`).
- `schedule` — standard 5-field cron; `concurrencyPolicy` — `Allow` | `Forbid` | `Replace`. CronJob wraps `jobTemplate`. See [Job vs CronJob](deep:p5-jobs).

### 10. HorizontalPodAutoscaler (`autoscaling/v2`, §2.3)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: demo-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: demo
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```
- `scaleTargetRef` — the workload to scale (must match a real Deployment/StatefulSet).
- `min/maxReplicas` — bounds; in **K8s 1.36** `minReplicas: 0` (scale-to-zero) is on by default.
- `metrics[]` — `Resource` (cpu/mem), `Pods`, `Object`, or `External`. Needs metrics-server. See [HPA algorithm](deep:p2-hpa-algorithm); event-driven scaling → [KEDA](deep:p2-keda).

### 11. NetworkPolicy (`networking.k8s.io/v1`, §1.1)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: demo-allow-from-frontend
spec:
  podSelector:
    matchLabels:
      app: demo
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 80
```
- `podSelector` — which Pods this policy **applies to** (empty `{}` = all in namespace).
- `policyTypes` — `Ingress` and/or `Egress`; listing a type with no rules = **deny all** of that direction.
- `ingress[].from` / `ports` — allowed sources (pod/namespace/IP-block selectors) and ports. Policies are **additive** and require a policy-enforcing CNI ([NetworkPolicy](deep:p1-network-policy)). Full walkthrough: [NetworkPolicy manifest](deep:p5-networkpolicy-manifest).

---

> **Apply order in practice:** namespaces/CRDs → ConfigMap/Secret → Deployment/StatefulSet+Service → Ingress → HPA/NetworkPolicy. `kubectl apply -f .` applies a directory; combine with `kubectl diff -f .` first ([dry-run & diff](deep:p5-dryrun-diff)) to preview.
