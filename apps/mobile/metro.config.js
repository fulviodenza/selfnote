// Metro config for the standalone Expo app inside the selfnote monorepo.
//
// apps/mobile is excluded from the pnpm workspace and has its own node_modules,
// but it consumes @selfnote/core (raw TS) via a file: symlink that lives outside
// the project root. Metro must therefore watch the monorepo root, and critically
// resolve the shared CRDT libs (yjs, lib0, y-websocket, y-protocols) to a SINGLE
// copy. If core resolved yjs from the pnpm store while the app used its own copy,
// there would be two Yjs runtimes and CRDT sync would silently break.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo so Metro can read packages/core/src.
config.watchFolders = [monorepoRoot];

// Resolve bare imports from the app's own node_modules first.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

// Force every import of these, from the app OR from @selfnote/core, to the app's
// single copy.
//
// This has to happen in resolveRequest rather than extraNodeModules. The latter is
// a FALLBACK Metro consults only when normal resolution FAILS, and packages/core
// carries its own node_modules/yjs and node_modules/y-websocket (pnpm symlinks into
// the store), so resolution from core succeeded on its own and the fallback never
// ran. That loaded two copies of each and tripped Yjs's "already imported"
// constructor check. lib0 and y-protocols only appeared to work because core has no
// copy of them, so for those two the fallback did fire.
const dedupe = ["yjs", "lib0", "y-websocket", "y-protocols"];
const dedupeRoots = Object.fromEntries(
  dedupe.map((name) => [name, path.resolve(projectRoot, "node_modules", name)]),
);

// getDefaultConfig already installs a resolveRequest; chain to it rather than
// replacing it, or Expo's own resolution behaviour is lost.
const defaultResolveRequest = config.resolver.resolveRequest;
const delegate = (context, moduleName, platform) =>
  (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const name of dedupe) {
    // Exact match or a subpath ("lib0/buffer"), but never a lookalike ("yjs-foo").
    if (moduleName === name || moduleName.startsWith(`${name}/`)) {
      return delegate(context, dedupeRoots[name] + moduleName.slice(name.length), platform);
    }
  }
  return delegate(context, moduleName, platform);
};

// Stub the browser-only y-indexeddb (imported by core, unused here). This one stays
// in extraNodeModules deliberately: it substitutes a module that is MEANT to fail
// normal resolution, which is exactly the case extraNodeModules is for.
config.resolver.extraNodeModules = {
  "y-indexeddb": path.resolve(projectRoot, "src/shims/y-indexeddb.js"),
};

module.exports = config;
