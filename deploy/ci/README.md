# CI runner (homelab)

The self-hosted GitHub Actions runner that builds the mobile APK, alongside the
runners for the other repos in the cluster's `ci` namespace. Driven by
[`.github/workflows/mobile-apk.yml`](../../.github/workflows/mobile-apk.yml).

As with `deploy/homelab/*.yaml`, the manifest here is a scrubbed example. The
cluster is the source of truth.

| File | What it is |
| --- | --- |
| `android-runner.Dockerfile` | Runner image: stock GitHub runner plus JDK 17, Node 20, `gh`, and the Android SDK |
| `runner-selfnote.yaml` | PVC, registration Secret, and Deployment for `github-runner-selfnote` |

## Bootstrap

### 1. Build and push the image

```sh
docker build -f deploy/ci/android-runner.Dockerfile \
  -t registry.fulvio.dev/selfnote/android-runner:sdk52 .
docker push registry.fulvio.dev/selfnote/android-runner:sdk52
```

It is a large image (the SDK, build-tools, and NDK are most of it). Rebuild it
when Expo SDK moves: the versions it pins come from the prebuild template, and
the NDK is the one Gradle will not download for itself.

### 2. Mint a registration token

GitHub repo → Settings → Actions → Runners → New self-hosted runner. Copy the
token out of the `./config.sh --token ...` line. It expires in about an hour.

```sh
kubectl -n ci create secret generic github-runner-selfnote-reg \
  --from-literal=token=THE_ONE_TIME_TOKEN
```

The token is only read on first boot. Once `state/.runner` exists on the PVC,
the runner re-uses that registration, so a pod restart does not need a new one.

### 3. Apply

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
- iOS is not covered. It needs macOS, which the cluster cannot provide.
