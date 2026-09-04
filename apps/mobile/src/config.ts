// No server is baked into the shipped app — the user picks their own instance in
// the first-launch onboarding (see src/settings.ts + the Onboarding screen). A
// developer can still preset one via EXPO_PUBLIC_* when building for convenience.
export const DEFAULT_SYNC_URL = process.env.EXPO_PUBLIC_SYNC_URL ?? "";
export const DEFAULT_API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
