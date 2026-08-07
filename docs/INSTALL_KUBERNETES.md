# Kubernetes installation

Plain YAML manifests, no Helm chart yet. Everything you need is in this page.

Manifests live in [deploy/kubernetes/](../deploy/kubernetes/):

| File | Purpose |
|---|---|
| `configmap.yaml` | Non-sensitive config (poll interval, log level, port, backend type) |
| `secret.example.yaml` | Template for credentials — copy and fill in, **never commit the copy** |
| `deployment.yaml` | The exporter itself (`replicas: 1` — see [Notes](#notes) below) |
| `service.yaml` | `ClusterIP` by default — see [Exposing the service outside the cluster](#exposing-the-service-outside-the-cluster) if Prometheus/Alloy runs elsewhere |
| `servicemonitor.yaml` / `podmonitor.yaml` | Prometheus Operator integration — pick one |
| `networkpolicy.yaml` | Optional; restricts ingress/egress |

## Install

```bash
kubectl create namespace monitoring   # or use an existing one
```

### 1. Create the Secret

Two options — pick whichever fits your workflow.

**Option A: generate directly from your `.env` file** (quickest, avoids hand-editing YAML):

```bash
kubectl create secret generic ftd-metrics-exporter-secrets \
  --namespace monitoring \
  --from-env-file=.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

This reads every `KEY=value` line in `.env` and creates a Secret from it — no plaintext credential ever touches a file on disk beyond your own `.env`. Note it will also pick up non-secret variables from the same file (e.g. `LOG_LEVEL`); harmless, but if you'd rather keep the Secret to credentials only, use Option B or trim `.env` down to just the credential lines first.

**Option B: edit the template manifest:**

```bash
cp deploy/kubernetes/secret.example.yaml deploy/kubernetes/secret.yaml
# edit secret.yaml with real SCC_API_TOKEN or FMC_USERNAME/FMC_PASSWORD
kubectl apply -f deploy/kubernetes/secret.yaml
```

### 2. Apply the rest

```bash
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f deploy/kubernetes/deployment.yaml
kubectl apply -f deploy/kubernetes/service.yaml
kubectl apply -f deploy/kubernetes/servicemonitor.yaml   # requires the Prometheus Operator CRDs
kubectl apply -f deploy/kubernetes/networkpolicy.yaml    # requires a NetworkPolicy-enforcing CNI
```

### 3. Verify

```bash
kubectl port-forward svc/ftd-metrics-exporter -n monitoring 10049:10049
curl http://localhost:10049/metrics
```

Should return `ftd_exporter_up 1`, same as the standalone/Docker paths.

## Exposing the service outside the cluster

`service.yaml` defaults to `type: ClusterIP` — only reachable from inside the cluster. That's correct when Prometheus/Alloy runs as another workload in the same cluster (the common case with the Prometheus Operator).

If your scraper runs **outside** the cluster (a standalone Prometheus/Alloy host, a different cluster, a managed observability platform), change the Service type to `LoadBalancer`:

```yaml
# service.yaml
spec:
  type: LoadBalancer   # was: ClusterIP
  selector:
    app.kubernetes.io/name: ftd-metrics-exporter
  ports:
    - name: metrics
      port: 10049
      targetPort: metrics
      protocol: TCP
```

Apply it, then find the assigned external address:

```bash
kubectl get svc ftd-metrics-exporter -n monitoring
```

Point your external Prometheus/Alloy scrape config at `<EXTERNAL-IP>:10049`. Requires a cloud provider or bare-metal load-balancer controller (e.g. MetalLB) that can satisfy `LoadBalancer` — on a cluster without one, the `EXTERNAL-IP` stays `<pending>` forever. `NodePort` is a simpler alternative if you don't have a load-balancer controller: any node's IP on the assigned port reaches the service.

**`/metrics` has no built-in authentication** — exposing it outside the cluster means it's reachable by anything that can reach that IP/port. Restrict with a firewall rule, a `NetworkPolicy` scoped to known source ranges, or the exporter's own mutual TLS (`METRICS_TLS_CLIENT_CA_PATH`) before doing this in production.

## Notes

- **`replicas: 1` is deliberate, not a placeholder** — two replicas double the upstream polling rate, which alone consumes SCC's entire 2-requests/minute budget at the default poll interval. See the comment in `deployment.yaml`.
- **`ServiceMonitor`'s `interval` is independent of `POLL_INTERVAL_SECONDS`** — the exporter always serves `/metrics` from its in-memory cache, so the Prometheus scrape interval can be much shorter than the poll interval at zero extra upstream cost. Setting them equal "to respect the rate limit" is the single most common mistake operators make here.
- **`NetworkPolicy` enforcement depends on your CNI.** Calico (e.g. `microk8s`'s default) enforces it; `kind`'s default `kindnet` CNI does not — applying the manifest under a non-enforcing CNI silently provides no isolation at all. Verify enforcement on your cluster before relying on it.
- **`networkpolicy.yaml`'s ingress selector must match your Prometheus's real namespace, which is often not `monitoring`.** Verified directly: microk8s's own `observability` addon runs Prometheus in a namespace called `observability`, and the shipped default (`monitoring`) left the scrape target permanently down with no error pointing at the NetworkPolicy as the cause. Update the namespace in both `networkpolicy.yaml` and wherever your Prometheus Operator is actually deployed before relying on either.
- **`networkpolicy.yaml`'s egress only opens port 443 by default.** `FMC_HOST` accepts an explicit `host:port`; if your on-prem FMC listens on a non-standard port, add that port to the egress rule too, or `backend.init()` fails with a connect-timeout error indistinguishable from a genuinely unreachable host.
- **Secret management**: `secret.example.yaml` is a template with placeholders only. For GitOps workflows, use External Secrets Operator, Sealed Secrets, SOPS, or your cloud provider's CSI secret driver instead of applying a hand-edited copy — and ensure etcd encryption-at-rest is enabled at the cluster level, since Kubernetes Secrets are base64-encoded in etcd, not encrypted.
- **CA bundle for on-prem FMC**: mount it as a read-only volume (see the commented-out `fmc-ca-bundle` volume/volumeMount in `deployment.yaml`) and point `FMC_CA_BUNDLE_PATH` at the mount path.
- **Changing `METRICS_PORT`** in `configmap.yaml` requires also updating `deployment.yaml`'s `containerPort`/probe ports/`prometheus.io/port` annotation and `service.yaml`'s ports — none of them read the ConfigMap value.
- **The image is pulled from GHCR** (`ghcr.io/apilbeam101/ftd-metrics-exporter`, public) — no `imagePullSecrets` needed. `deployment.yaml` pins the minor tag by default; see the comment there for digest pinning. Building and loading a local image instead (contributors, air-gapped clusters) is documented in that same comment.

## Troubleshooting

Config errors, credential/TLS failures, and NetworkPolicy-related reachability issues (both directions — egress to FMC/SCC, ingress from Prometheus) are covered in [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).
