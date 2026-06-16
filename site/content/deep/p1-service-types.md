# Service types — how they layer

The five Service types aren't five separate mechanisms; the external ones **build on** ClusterIP. Knowing the stacking answers "which type, when?" cleanly.

```mermaid
flowchart LR
  EXT["external client"] --> LB["LoadBalancer<br/>cloud LB to nodes"]
  LB --> NP["NodePort<br/>NodeIP port 30000-32767"]
  NP --> CIP["ClusterIP<br/>stable VIP"]
  CIP --> EP["EndpointSlices to Ready Pods"]
```

## The five

| Type | Adds over the layer below | Use when |
|---|---|---|
| **ClusterIP** (default) | a stable in-cluster VIP + DNS | internal service-to-service |
| **NodePort** | opens a port on **every** node that forwards to the ClusterIP | dev/debug, or a building block under an external LB |
| **LoadBalancer** | asks the cloud (via cloud-controller-manager) for an external LB that targets the NodePort | expose **one** L4/TCP service externally |
| **Headless** (`clusterIP: None`) | *no* VIP — DNS returns Pod IPs directly | StatefulSets, DBs needing per-Pod identity (§2.4) |
| **ExternalName** | a DNS CNAME, no proxying at all | alias an external host as an in-cluster name |

## The mechanics worth knowing

- **NodePort range** is `30000–32767` by default; the port is opened on *all* nodes regardless of where Pods run, then [kube-proxy](deep:p1-kube-proxy) DNATs inward via the ClusterIP and its [EndpointSlices](deep:p1-endpointslices).
- **LoadBalancer is one-cloud-LB-per-Service** and L4 only — which is exactly the cost that motivates [Ingress / Gateway API](deep:p1-gateway-api) for HTTP (many apps behind one LB, L7 routing).
- **Headless** skips the VIP entirely: a normal headless Service returns A records for all Ready Pods; with a StatefulSet you also get stable `pod-0.svc...` names. There's no kube-proxy load balancing — the client picks.
- **`externalTrafficPolicy`**: `Cluster` (default) load-balances across all nodes but **SNATs**, losing the client source IP; `Local` preserves the source IP but only routes to Pods on the receiving node (and a node with no local Pod drops the traffic).

## Failure modes

- **LoadBalancer stuck `<pending>`** for its external IP → no cloud-controller-manager (bare-metal needs MetalLB or similar).
- **Wrong `targetPort`** → endpoints exist but connections refuse: the Service port maps to a container port nothing listens on.
- **Headless with `publishNotReadyAddresses`** intentionally surfaces not-ready Pods for peer discovery during StatefulSet bootstrap.

## Interview angle
"ClusterIP vs NodePort vs LoadBalancer vs Ingress?" → they layer (LB → NodePort → ClusterIP → Pods); ClusterIP for internal, LoadBalancer for non-HTTP external, Ingress/Gateway for HTTP at the edge, NodePort mostly a building block. "Why does my LB lose the client IP?" → `externalTrafficPolicy: Cluster` SNATs; switch to `Local`.
