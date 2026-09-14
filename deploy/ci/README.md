# CI runner (homelab)

The self-hosted GitHub Actions runner that builds the mobile APK, alongside the
runners for the other repos in the cluster's `ci` namespace. Driven by
[`.github/workflows/mobile-apk.yml`](../../.github/workflows/mobile-apk.yml).

As with `deploy/homelab/*.yaml`, the manifest here is a scrubbed example. The
cluster is the source of truth.

| File | What it is |
| --- | --- |
| `android-runner.Dockerfile` | Runner image: stock GitHub runner plus JDK 17, Node 20, `gh`, and the Android SDK |
| `runner-selfnote.yaml` | PVC and Deployment for `github-runner-selfnote` (the Secrets are created out of band, see below) |

## Bootstrap

Order matters: the registration token expires in about an hour, so mint it
immediately before applying.

### 1. Build and push the image

```sh
docker build -f deploy/ci/android-runner.Dockerfile \
  -t registry.fulvio.dev/selfnote/android-runner:sdk52 .
docker push registry.fulvio.dev/selfnote/android-runner:sdk52
```

It is a large image (the SDK, build-tools, and NDK are most of it). Rebuild it
when Expo SDK moves: the versions it pins come from the prebuild template, and
the NDK is the one Gradle will not download for itself.

Two traps on this step:

- A direct push to `registry.fulvio.dev` fails with `413 Payload Too Large`.
  The hostname goes through Cloudflare, which caps upload size well below the
  multi-GB SDK layer. Push around it through the Harbor service instead:

  ```sh
  kubectl -n harbor port-forward svc/harbor 8443:443 &
  docker tag registry.fulvio.dev/selfnote/android-runner:sdk52 \
    127.0.0.1:8443/selfnote/android-runner:sdk52
  docker push 127.0.0.1:8443/selfnote/android-runner:sdk52
  ```

  The repository inside Harbor is the same either way, so the cluster still
  pulls it as `registry.fulvio.dev/selfnote/android-runner:sdk52` (pulls are
  downloads and pass through Cloudflare fine).

- If the build fails at the `FROM` line with `failed to fetch oauth token:
  denied`, a stale `ghcr.io` credential in `~/.docker/config.json` is being
  sent for a public image. `docker logout ghcr.io` clears it.

### 2. Give the `ci` namespace a Harbor pull secret

Pull secrets are namespace-scoped, so the `harbor` secret in `selfnote` and
`default` does not help here. Without this the pod sits in ImagePullBackOff.

```sh
kubectl -n ci create secret docker-registry harbor \
  --docker-server=registry.fulvio.dev \
  --docker-username=<harbor-user> \
  --docker-password=<harbor-password>
```

### 3. Mint a registration token

GitHub repo → Settings → Actions → Runners → New self-hosted runner. Copy the
token out of the `./config.sh --token ...` line.

```sh
kubectl -n ci create secret generic github-runner-selfnote-reg \
  --from-literal=token=THE_ONE_TIME_TOKEN
```

This Secret is created here rather than in `runner-selfnote.yaml` on purpose. A
placeholder in the manifest would win every `kubectl apply` and overwrite the
real token, and the only symptom would be a pod crash-looping on a token
`config.sh` rejects.

The token is read on first boot only. Once `state/.runner` exists on the PVC
the runner re-uses that registration, so a pod restart does not need a new one.

### 4. Apply

```sh
kubectl apply -f deploy/ci/runner-selfnote.yaml
kubectl -n ci rollout status deploy/github-runner-selfnote
```

The runner should then show up under Settings → Actions → Runners as
`k3s-home-selfnote`, idle, with labels `self-hosted` and `home`.

## Re-registering

If the PVC is lost, or the runner shows offline and will not recover, mint a
fresh token, update the Secret, and delete the pod:

```sh
kubectl -n ci create secret generic github-runner-selfnote-reg \
  --from-literal=token=NEW_TOKEN --dry-run=client -o yaml | kubectl apply -f -
kubectl -n ci delete pod -l app=github-runner-selfnote
```

Clearing `state/.runner` on the PVC forces a full re-register on the next boot.

## Signing

The workflow adds no keystore. `expo prebuild` writes
`android/app/debug.keystore` from the Expo template, and the template's
`release` build type signs with that file rather than with `~/.android/`. Since
the keystore is a fixed blob inside the published template package, every build
anywhere produces the same signing key, so CI matches local builds and existing
sideloads upgrade in place.

That private key is public, which means anyone can build an APK Android will
accept as an upgrade over an installed Selfnote. That has been true of every
APK released so far. Before Selfnote is installed by anyone but its author,
generate a real release keystore, keep it in a Secret, and point a
`signingConfig` at it. Existing installs will need one uninstall at that point.

## Notes

- The trigger is push-to-main only, never `pull_request`. A fork PR on a
  self-hosted runner runs attacker-controlled code inside the homelab.
- There is no dind sidecar here, unlike the other runners in the namespace.
  Nothing in this job builds container images, so nothing needs `privileged`.
- Gradle and npm caches live on the state PVC (`GRADLE_USER_HOME`,
  `npm_config_cache`). That is why the claim is 40Gi rather than the 5Gi the
  other runners use, and why it is a separate claim: the k3s local-path
  provisioner cannot expand a volume in place.
- The pod is pinned to `homelab-2` with a `nodeSelector`. local-path binds the
  volume to whichever node the pod first lands on, so the node is worth picking
  deliberately, and homelab-2's 20Gi is what makes the 12Gi memory limit
  meaningful rather than larger than the node itself.
- iOS is not covered. It needs macOS, which the cluster cannot provide.
