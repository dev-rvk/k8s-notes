# kubectl -o : output formats & jsonpath

`-o` controls how `kubectl get` renders objects. The defaults are for humans; `yaml`/`json`/`jsonpath` are for scripting and for seeing fields the table view hides.

## The formats

| `-o` value | Output | Use |
|---|---|---|
| *(none)* | default table | quick scan |
| `wide` | table + extra columns (node, IP, nominated node) | "which node is this Pod on?" |
| `name` | `kind/name` only | piping into `xargs kubectl delete` |
| `yaml` / `json` | the **full live object** incl. status & defaults | inspect, copy to a manifest |
| `jsonpath='{…}'` | extract specific fields | scripting without `jq` |
| `go-template=…` | full Go templating | complex extraction |
| `custom-columns=…` | pick columns by path | tidy ad-hoc tables |

## jsonpath, the useful one

```bash
# one field
kubectl get pod demo -o jsonpath='{.status.podIP}'

# loop over a list (range) — newline per item
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}'

# filter with [?()]
kubectl get pods -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}'

# all container images in the namespace
kubectl get pods -o jsonpath='{.items[*].spec.containers[*].image}'

# custom-columns equivalent
kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName
```

- `{.items[*]}` walks a List (what `get <kind>` returns); a single object has no `.items`.
- `{range …}{end}` iterates and lets you emit literal `\t` / `\n` between fields.
- `[?(@.field=="x")]` is a filter expression on list elements.

## Gotchas

- **jsonpath operates on JSON field names**, which are camelCase (`nodeName`, `podIP`) — not the YAML you may have written. Dump `-o json` to confirm the path.
- Quote the whole expression in **single quotes** in bash so `$`, `*`, `?`, `()` aren't eaten by the shell.
- `-o yaml` shows **server-populated** fields (`status`, `creationTimestamp`, `resourceVersion`, defaulted values) — strip those before reusing it as a manifest (`kubectl get … -o yaml | kubectl-neat` or just delete the noise).
- jsonpath's filter syntax is limited (no regex, fragile with missing fields); reach for `jq` on `-o json` when it gets hairy.

## Interview angle
"Get every Pod's name and node without grep/awk?" → `-o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName` or a jsonpath `range`. "Why does my jsonpath return nothing?" → you used the YAML key, but jsonpath wants the JSON (camelCase) field — check `-o json`.
