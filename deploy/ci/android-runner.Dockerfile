# Self-hosted GitHub Actions runner with an Android build toolchain, used by
# .github/workflows/mobile-apk.yml to build the Selfnote APK in the homelab
# cluster. The other runners in the `ci` namespace use the stock image; this one
# needs a JDK, the Android SDK, and Node, so it is built and pushed to Harbor.
# The push must go through a port-forward to the Harbor service, never through
# registry.fulvio.dev (Cloudflare 413s the multi-GB SDK layer): the full
# recipe is in deploy/ci/README.md.
#
# Versions below are not guesses. They are what `expo prebuild` lays down for
# Expo SDK 52, read from expo-template-bare-minimum@52.0.46:
#
#   compileSdk 35 | targetSdk 34 | minSdk 24 | buildTools 35.0.0
#   ndk 26.1.10909125
#
# Kotlin is not baked in here: the template's default drifts with the sdk-52
# dist-tag, so the workflow pins android.kotlinVersion in gradle.properties
# instead (see .github/workflows/mobile-apk.yml). Re-pin both together when
# Expo SDK moves.
#
# Only the NDK has to be exact. Gradle downloads a missing SDK platform or
# build-tools package on its own, but never an NDK, so a wrong pin here is a
# build failure rather than a slow first run. Re-pin it when Expo SDK moves:
# it lives in the template's android/build.gradle.
FROM ghcr.io/actions/actions-runner:2.337.0

USER root

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=20
ARG ANDROID_CMDLINE_TOOLS=13114758
ARG ANDROID_NDK=26.1.10909125
ARG ANDROID_BUILD_TOOLS=35.0.0

# gh is here because the release step shells out to it. The stock runner image
# is minimal and, unlike GitHub's ubuntu-latest, ships neither gh nor a JDK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git unzip zip openjdk-17-jdk-headless \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs gh \
 && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools"

# sdkmanager insists on living at cmdline-tools/latest/, not at the root of the
# zip it ships in.
RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" \
 && curl -fsSL -o /tmp/tools.zip \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" \
 && unzip -q /tmp/tools.zip -d "${ANDROID_HOME}/cmdline-tools" \
 && mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" \
 && rm /tmp/tools.zip

# yes | ... accepts the SDK licences. Without this every sdkmanager call in the
# job would block forever waiting on stdin.
RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install \
      "platform-tools" \
      "platforms;android-35" \
      "platforms;android-34" \
      "build-tools;${ANDROID_BUILD_TOOLS}" \
      "ndk;${ANDROID_NDK}" \
      > /dev/null \
 && chown -R runner:runner "${ANDROID_HOME}"

USER runner
