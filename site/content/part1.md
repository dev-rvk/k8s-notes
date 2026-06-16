# Kubernetes Notes — Part 1: Foundations (Networking → Workloads → Ingress)

> **How to use:** every concept follows **Why → What → Diagram → Gotchas**. Interview questions are pooled at the end (§1.9) and link multiple concepts rather than repeating them. Cross-references use `§X.Y` (e.g. `§2.3` = Part 2, section 3). Diagrams are inline mermaid.

**Contents:** 1.1 Networking concepts · 1.2 Cluster architecture · 1.3 Pods · 1.4 Labels/Selectors/Namespaces · 1.5 ReplicaSets · 1.6 Deployments · 1.7 Services · 1.8 Ingress · 1.9 Interview questions

---

## 1.1 Networking concepts (the K8s-specific ones to revise)

> You already know OSI/TCP. These are the **networking concepts these notes assume** — the ones that actually appear in K8s.

| Concept | One-liner | Where it shows up |
|---|---|---|
| **Flat pod network** | Every Pod gets its own cluster-wide IP; any Pod can reach any Pod, no NAT | §1.3 |
| **[CNI](deep:p1-cni)** (Container Network Interface) | The plugin that *implements* that network (Calico, Cilium, Flannel) | cluster setup |
| **[kube-proxy](deep:p1-kube-proxy)** | Programs the node so a Service's virtual IP forwards to real Pod IPs (modes: iptables / IPVS / nftables) | §1.7 |
| **[CoreDNS](deep:p1-coredns)** | In-cluster DNS: `service.namespace.svc.cluster.local` | §1.7 |
| **L4 vs L7** | Service = L4 (TCP/UDP); Ingress = L7 (HTTP host/path) | §1.7, §1.8 |
| **North-south vs east-west** | In/out of the cluster vs Pod-to-Pod | diagram below |
| **[NetworkPolicy](deep:p1-network-policy)** | L3/L4 firewall *between* Pods (default = everything allowed) | security |
| **[Gateway API](deep:p1-gateway-api)** | The newer, GA successor to Ingress | §1.8 |

```mermaid
flowchart TB
  CLIENT["external client"] -->|north-south| LB["Load Balancer"]
  LB --> ING["Ingress controller , L7 HTTP routing"]
  ING --> SVC1["Service , ClusterIP"]
  SVC1 --> POD1["backend pod"]
  POD1 -->|east-west| SVC2["Service , ClusterIP , L4"]
  SVC2 --> POD2["redis or db pod"]
```

**The flat-network model (3 rules every CNI must satisfy):** (1) every Pod gets a unique cluster-wide IP; (2) Pods on the same node talk without NAT; (3) Pods across nodes talk without NAT. Whoever implements those rules — the [CNI](deep:p1-cni) — is free to do it with overlays (VXLAN), pure routing (BGP), or eBPF. K8s itself ships **no** pod network; an un-CNI'd cluster leaves every node `NotReady`.

**Gotchas:** Ingress is *only* north-south HTTP — it never touches Pod-to-Pod traffic. All internal service-to-service goes through ClusterIP + DNS. [NetworkPolicy](deep:p1-network-policy) is opt-in; without it everything can talk to everything. The flat model means there is **no implicit isolation** — a compromised Pod can reach every other Pod and every Service VIP until a policy says otherwise.

---

## 1.2 Cluster architecture (short)

**Why:** to know *who acts* when you apply a manifest. **What:** a control plane (decides) + worker nodes (run the work), all driven by a reconcile loop.

```mermaid
flowchart TB
  subgraph CP["Control plane - the brain"]
    API["kube-apiserver<br/>front door , auth , validate"]
    ETCD["etcd<br/>the only source of truth"]
    SCHED["kube-scheduler<br/>picks a node per pod"]
    CM["controller-manager<br/>reconcile loops"]
    CCM["cloud-controller-manager<br/>cloud LBs , disks , nodes"]
  end
  subgraph N1["Worker node 1"]
    K1["kubelet"]
    KP1["kube-proxy"]
    subgraph P1A["Pod A"]
      C1A["container"]
    end
    subgraph P1B["Pod B"]
      C1B["container + sidecar"]
    end
  end
  subgraph N2["Worker node 2"]
    K2["kubelet"]
    KP2["kube-proxy"]
    subgraph P2A["Pod C"]
      C2A["container"]
    end
  end
  API --> ETCD
  SCHED --> API
  CM --> API
  CCM --> API
  K1 --> API
  K2 --> API
```

| Component | Job | Why it exists |
|---|---|---|
| **kube-apiserver** | The only thing that talks to etcd; all reads/writes go through it; serves the **watch** stream everything else subscribes to | single, audited entry point |
| **[etcd](deep:p1-etcd)** | Stores desired + actual state as versioned key/value; Raft-replicated | durable cluster memory |
| **[scheduler](deep:p1-scheduler)** | Assigns Pods → nodes (filter then score: resources, affinity, taints) | placement decisions |
| **controller-manager** | Runs [reconcile loops](deep:p1-reconcile-loop) (Deployment, RS, node, endpoint, etc.) | makes reality match desired |
| **kubelet** | On each node: starts containers via CRI, runs probes, reports health | node-level executor |
| **[kube-proxy](deep:p1-kube-proxy)** | Implements Service networking on the node | turns Service VIP → Pod IPs |

**Nothing polls — everything *watches*.** Components don't repeatedly ask "what's new?"; they open a long-lived **watch** on the apiserver and get pushed incremental events (backed by etcd's revision/`watch` API). The apiserver is the only client of [etcd](deep:p1-etcd); every other component is a client of the apiserver. That single choke point is what makes auth, admission, and audit possible.

**The declarative reconcile loop** — the single most important idea in K8s:

```mermaid
flowchart TB
  A["kubectl apply -f deploy.yaml"] --> B["kube-apiserver , auth + validate"]
  B --> C["write DESIRED state to etcd"]
  C --> D{"object type?"}
  D -->|Deployment| E["controller creates a ReplicaSet"]
  E --> F["RS controller creates Pods , unscheduled"]
  F --> G["scheduler assigns each Pod a node"]
  G --> H["kubelet pulls image , starts container"]
  H --> I["kubelet reports ACTUAL state to apiserver"]
  I --> J{"actual == desired?"}
  J -->|no| K["controllers take corrective action"]
  K --> J
  J -->|yes| L["steady state , keep watching"]
```

**Gotchas:** you never tell K8s *how* — you declare *what* and controllers converge (the [reconcile loop](deep:p1-reconcile-loop)). Nothing bypasses the apiserver. [etcd](deep:p1-etcd) is the source of truth; lose it, lose the cluster state — back it up. The loop is **level-triggered, not edge-triggered**: a controller acts on the *current observed state*, not on the event that woke it, so a missed event is self-correcting on the next resync.

---

## 1.3 Pods

**Why:** the smallest deployable unit; a wrapper for one or more containers that must **share fate, network, and storage**. **What:** containers in a Pod share one IP (talk over `localhost`) and can share volumes.

```mermaid
flowchart TB
  subgraph POD["Pod - one shared IP , shared localhost"]
    INIT["initContainer<br/>runs to completion FIRST"]
    MAIN["app container"]
    SIDE["sidecar<br/>log shipper / proxy / config writer"]
    VOL["shared volume"]
    INIT -.->|then starts| MAIN
    MAIN --- VOL
    SIDE --- VOL
  end
```

A Pod shares a **network namespace** (one IP, `localhost`) and can share **storage** (volumes) and optionally a **PID** namespace. The infra/pause container holds the namespaces open so app containers can restart without the IP changing. See [init vs sidecar](deep:p1-init-vs-sidecar) for ordering — and note **native sidecars** are now GA (K8s 1.33): an init container with `restartPolicy: Always` starts before the app *and* keeps running alongside it.

**Lifecycle phases + restart logic** — the [Pod lifecycle](deep:p1-pod-lifecycle) phase is a coarse summary; the per-container probes are what actually gate traffic:

```mermaid
flowchart LR
  PENDING["Pending<br/>scheduling , pulling image , init containers"] --> RUNNING["Running<br/>at least one container live"]
  RUNNING --> SUCCEEDED["Succeeded<br/>all exited 0 , e.g. Jobs"]
  RUNNING -->|container exits| RESTART{"restartPolicy?"}
  RESTART -->|Always or OnFailure| RUNNING
  RESTART -->|Never| FAILED["Failed"]
```

**Probes** ([readiness vs liveness](deep:p1-readiness-vs-liveness)) run independently of the phase: **startup** gates the other two during slow boots, **liveness** restarts a wedged container, **readiness** adds/removes the Pod from Service [endpoints](deep:p1-endpointslices). A Pod can be `Running` yet **not Ready** — and therefore get zero traffic.

**Gotchas:** Pods are **ephemeral and mortal** — never create them directly in prod; let a controller (§1.6) own them. One IP per Pod, not per container. `Running` is a phase, not a promise of readiness. Common multi-container patterns: **init** (setup before main), **sidecar** (helper alongside main — e.g. the frontend `config.js` writer from our earlier discussion).

---

## 1.4 Labels, Selectors, Namespaces

**Why:** labels are the **glue**; selectors are how controllers and Services *find* the Pods they manage; namespaces partition a cluster. **What:** key/value tags + queries over them.

```mermaid
flowchart TB
  DEP["Deployment<br/>selector: app=web"] -->|manages| RS["ReplicaSet<br/>selector: app=web"]
  RS -->|creates , stamps app=web| P1["Pod , app=web"]
  RS --> P2["Pod , app=web"]
  SVC["Service<br/>selector: app=web"] -.->|matches the SAME label| P1
  SVC -.-> P2
```

**Gotchas:** a Service finds Pods by the **same label** the Deployment stamps — mismatch = no endpoints = no traffic (a top interview trap, §1.9). A Deployment's `selector` is **immutable**. Namespaces are scoping/quota boundaries, **not** security boundaries by themselves (you still need RBAC + NetworkPolicy).

---

## 1.5 ReplicaSets

**Why:** keep exactly **N identical Pods** alive (self-healing). **What:** a controller that watches Pod count and corrects it.

```mermaid
flowchart TB
  START["RS controller wakes / Pod event"] --> COUNT{"running Pods vs desired"}
  COUNT -->|fewer| CREATE["create missing Pods"]
  COUNT -->|more| DELETE["delete extra Pods"]
  COUNT -->|equal| WAIT["do nothing"]
  CREATE --> COUNT
  DELETE --> COUNT
  WAIT --> COUNT
```

**Gotchas:** you almost never create an RS directly — a Deployment manages it for you (§1.6). RS owns its Pods via `ownerReferences`; delete a Pod and the RS recreates it. This is the [reconcile loop](deep:p1-reconcile-loop) at its simplest: observe count → diff against desired → act. The RS matches Pods purely by **label selector**, so a stray Pod with matching labels gets *adopted* (and counts toward `replicas`) — a classic surprise.

---

## 1.6 Deployments

**Why:** RS alone can't do **rollouts/rollbacks**. A Deployment manages *versioned* ReplicaSets to give you zero-downtime updates and history. **What:** Deployment → (active + old) ReplicaSets → Pods.

```mermaid
flowchart TB
  DEP["Deployment: web<br/>image v2 , replicas 3"] -->|active| RS2["ReplicaSet v2<br/>3 pods"]
  DEP -.->|kept at 0 for rollback| RS1["ReplicaSet v1"]
  RS2 --> PA["Pod"]
  RS2 --> PB["Pod"]
  RS2 --> PC["Pod"]
```

**Rolling update logic (zero-downtime):**

```mermaid
flowchart TB
  S["spec updated , new image"] --> NEW["create new ReplicaSet"]
  NEW --> STEP{"within maxSurge / maxUnavailable?"}
  STEP -->|yes| UP["scale new RS up by 1"]
  UP --> READY{"new Pod Ready?"}
  READY -->|no| WAITP["wait , do NOT proceed"]
  WAITP --> READY
  READY -->|yes| DOWN["scale old RS down by 1"]
  DOWN --> DONE{"all Pods migrated?"}
  DONE -->|no| STEP
  DONE -->|yes| FIN["rollout complete , old RS kept at 0"]
```

**The [maxSurge / maxUnavailable math](deep:p1-rolling-update-math)** decides how aggressive the rollout is. With `replicas: 10`, `maxSurge: 25%` (→ up to 13 Pods total) and `maxUnavailable: 25%` (→ at least 8 available), the controller scales the new RS up and old RS down one *batch* at a time, never breaching either bound. Percentages round **surge up** and **unavailable down**, so `maxUnavailable: 0` guarantees no capacity loss but requires headroom to surge.

**Gotchas:** the **[readiness probe](deep:p1-readiness-vs-liveness)** (§2.3) gates each step — no probe means the rollout "completes" instantly while traffic hits not-ready Pods. `maxUnavailable: 0` + `maxSurge: 0` is **illegal** (rollout can't move). Rollback with `kubectl rollout undo`; old RSs are retained per `revisionHistoryLimit`. Strategies: `RollingUpdate` (default) vs `Recreate` (kill all, then start — causes downtime). A change to the Pod template hash spawns a new RS; editing only the replica count does **not**.

---

## 1.7 Services

**Why:** Pods are ephemeral with **changing IPs** — you can't hardcode them. A Service gives a **stable virtual IP + DNS name + load balancing** over a changing set of Pods. **What:** a selector → a live list of healthy Pod endpoints, fronted by a fixed VIP.

```mermaid
flowchart TB
  CALLER["caller pod or ingress"] --> SVC["Service: web<br/>stable ClusterIP + DNS"]
  SVC -->|kube-proxy load-balances| EP{"any READY endpoints?"}
  EP -->|yes| P1["Pod"]
  EP --> P2["Pod"]
  EP -->|none ready| ERR["connection refused / 503"]
```

| Type | Reachable from | Use case |
|---|---|---|
| **[ClusterIP](deep:p1-service-types)** (default) | inside cluster only | internal service-to-service |
| **NodePort** | `NodeIP:port` | dev/debug; building block under LB |
| **LoadBalancer** | external, via cloud LB | expose **one** TCP service externally |
| **Headless** (`clusterIP: None`) | direct per-Pod DNS | StatefulSets / DBs (§2.4) |
| **ExternalName** | DNS CNAME | alias an external host |

**What actually sits behind the VIP — [EndpointSlices](deep:p1-endpointslices).** The selector doesn't route traffic directly; the **endpoint controller** watches Ready Pods and writes their IPs into EndpointSlice objects (the scalable successor to the single `Endpoints` object). [kube-proxy](deep:p1-kube-proxy) watches those slices and programs the node so the VIP DNATs to a real Pod IP. So the chain is: **Pod Ready → EndpointSlice updated → kube-proxy reprograms → traffic flows.**

**DNS resolution path** (why you use names, never the VIP) — handled by [CoreDNS](deep:p1-coredns):

```mermaid
flowchart LR
  APP["app , connect to web"] --> RESOLV["/etc/resolv.conf<br/>search ns.svc.cluster.local"]
  RESOLV --> CDNS["CoreDNS , kubernetes plugin"]
  CDNS --> ANS["returns Service ClusterIP<br/>or Pod IPs if headless"]
  ANS --> KP["kube-proxy DNAT to a Ready Pod"]
```

**How the types layer** (each builds on the previous):

```mermaid
flowchart LR
  EXT["external client"] --> LBV["LoadBalancer"] --> NPV["NodePort"] --> CIP["ClusterIP"] --> PODS["Pods"]
```

**Gotchas:** ClusterIP is **L4** — it has no idea about HTTP paths (that's Ingress, §1.8). Only **Ready** Pods (readiness probe, §2.3) appear in the [EndpointSlice](deep:p1-endpointslices). Use the DNS name, never the VIP (the VIP is just a kube-proxy rule, not a real interface — you can't ping it). Headless gives stable identity for stateful workloads. The VIP is **load-balanced per-connection, not per-request**, so long-lived HTTP/2 or gRPC connections pin to one Pod — use a real L7 proxy (Ingress/Gateway/mesh) if you need per-request balancing.

---

## 1.8 Ingress

**Why:** a `LoadBalancer` Service per app means **many cloud LBs** and only L4. Ingress gives **one entry point**, **L7 host/path routing**, and **TLS termination** — many HTTP services behind one LB. **What:** *rules* (the Ingress object) executed by a *proxy* (the Ingress controller).

```mermaid
flowchart TB
  USER["browser"] --> LB["cloud Load Balancer , 1 per cluster"]
  LB --> CTRL["Ingress Controller<br/>nginx / traefik , the PROXY"]
  CTRL -->|watches| RULES["Ingress objects<br/>host + path rules"]
  CTRL --> R{"match host + path?"}
  R -->|to frontend| FE["Service: frontend"] --> FEP["frontend Pods"]
  R -->|to backend| BE["Service: backend"] --> BEP["backend Pods"]
  R -->|no match| D404["404 default backend"]
```

| Thing | What it is |
|---|---|
| **Ingress object** | The *rules* (data): host/path → Service. Inert on its own. |
| **Ingress controller** | The *engine*: a proxy that watches all Ingress objects and routes. **One per cluster.** |
| **Service** | What the rules point at; does the L4 hop to Pods. |

**Ingress vs [Gateway API](deep:p1-gateway-api).** Gateway API's core resources (GatewayClass, Gateway, HTTPRoute) reached **v1 GA** (Gateway API v1.0, Oct 2023) and the spec has matured steadily since. It splits one monolithic Ingress object into role-oriented resources — infra team owns `GatewayClass`/`Gateway`, app teams own `HTTPRoute` — and natively expresses header/weight routing, traffic splitting, and non-HTTP protocols. **Ingress is in maintenance mode**: no new features, only bug/security fixes. New L7 work should target Gateway API.

| | Ingress | Gateway API |
|---|---|---|
| Object model | one object, vendor annotations for everything | `GatewayClass` + `Gateway` + `*Route`, role-split |
| Expressiveness | host/path + TLS; rest via annotations | header/method/weight routing, splits, cross-namespace refs |
| Protocols | HTTP(S) only | HTTP, gRPC, TCP, TLS, UDP |
| Status (2026) | frozen / maintenance | GA, the recommended path |

**Gotchas:** an Ingress object with **no controller installed does nothing**. Ingress is **HTTP(S)/L7 only** — raw TCP (DBs, Kafka) doesn't belong here (§1.7 LoadBalancer/headless instead). **One host = one Ingress owner** to avoid ownership fights (§3.2). Annotations are vendor-specific — an nginx Ingress doesn't port to Traefik unrewritten; Gateway API exists partly to kill that lock-in.

---

## 1.9 Interview questions (synthesis — links multiple concepts)

**Q1. Trace a packet from an external browser to a specific container.**
Browser → cloud LB → Ingress **controller** Pod → matches an Ingress **rule** (host+path, §1.8) → target **Service** ClusterIP (§1.7) → **kube-proxy** DNATs to a healthy **Pod endpoint** (§1.1) → container. North-south the whole way.

**Q2. A Pod is `Running` but clients get nothing through its Service. Causes?**
Service **selector ≠ Pod labels** (§1.4); **readiness probe failing** so the Pod isn't an endpoint (§2.3 + §1.7); **wrong `targetPort`**; a **NetworkPolicy** blocking it (§1.1). "Running" ≠ "in the endpoint list."

**Q3. You delete a Pod owned by a Deployment — then delete its ReplicaSet. What happens?**
RS controller recreates the Pod (§1.5). Delete the RS → the **Deployment** recreates the RS *and* its Pods (§1.6). Ownership chain Deployment → RS → Pod, all driven by the reconcile loop (§1.2).

**Q4. Why is a Pod IP unsafe to depend on, and what does K8s give you instead?**
Pods are ephemeral; IPs change on reschedule (§1.3). Use the **Service ClusterIP** (stable VIP), the **CoreDNS name** (§1.1), and **label-selector** discovery (§1.4) — three layers that survive Pod churn.

**Q5. How does a rolling update stay zero-downtime, and what silently breaks it?**
New RS scales up while old scales down within `maxSurge`/`maxUnavailable` (§1.6); the **readiness probe** decides when a new Pod joins the Service's endpoints (§1.7, §2.3). Breaks when the readiness probe is missing or too lenient → the Service routes to Pods that aren't actually ready.

**Q6. ClusterIP vs NodePort vs LoadBalancer vs Ingress — when, and how do they relate?**
They *layer*: LoadBalancer → NodePort → ClusterIP → Pods (§1.7). Use **ClusterIP** internally, **Ingress** for HTTP at the edge (many apps, one LB, L7), **LoadBalancer** for non-HTTP/TCP at the edge. NodePort is mostly a building block.

**Q7. Difference between an Ingress and an Ingress Controller — and what if there's no controller?**
Object = rules (data); controller = the proxy that executes them (engine), one per cluster (§1.8). With no controller installed, the Ingress object exists but **nothing routes** — it's inert.

**Q8. Where do the control plane and a worker node each act during `kubectl apply`?**
apiserver validates + writes desired state to etcd; controllers create RS/Pods; scheduler places them; the node's **kubelet** pulls images and runs containers and reports back; **kube-proxy** wires Service traffic (§1.2). Control plane *decides*, node *executes*.

**Q9. You scale a Deployment from 3 to 30 replicas and new Pods take ~40s to warm up. Without changing the app, how do you keep the Service from 503-ing during the surge — and which components cooperate?**
The fix spans four mechanisms: a **readiness probe** (§2.3) so a warming Pod isn't added to the [EndpointSlice](deep:p1-endpointslices) until it can serve; a **startup probe** so a slow boot doesn't trip liveness and restart-loop; the **endpoint controller + [kube-proxy](deep:p1-kube-proxy)** only program the VIP toward Ready Pods; and (for rollouts) `maxUnavailable` ([rollout math](deep:p1-rolling-update-math)) so capacity never dips below the floor. The trap: "Running" Pods that aren't Ready still don't get traffic — that's the system working, not failing.

**Q10. A Pod can resolve `web` but connections hang; another Pod in a different namespace can't even resolve it. Walk the two failures.**
Resolution but no connection = name → ClusterIP works ([CoreDNS](deep:p1-coredns)), but the VIP has **no Ready endpoints** (selector mismatch §1.4, or readiness failing) — kube-proxy has nothing to DNAT to. Can't resolve from another namespace = short-name lookup relies on the **`search` domain** in `resolv.conf`; cross-namespace needs the FQDN `web.<ns>.svc.cluster.local`. If even the FQDN fails, suspect a [NetworkPolicy](deep:p1-network-policy) blocking egress to CoreDNS on UDP/TCP 53.
