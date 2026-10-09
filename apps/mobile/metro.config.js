// Metro config for the standalone Expo app inside the selfnote monorepo.
//
// apps/mobile is excluded from the pnpm workspace and has its own node_modules,
// but it consumes @selfnote/core (raw TS) via a file: symlink that lives outside
// the project root. Metro must therefore watch the monorepo root, and resolve the
// shared CRDT libs (yjs, lib0, y-websocket, y-protocols) to a single copy. If core
// resolved yjs from the pnpm store while the app used its own, there would be two
// Yjs runtimes and CRDT sync would silently break.
const { getDefaultConfig } = require("expo/metro-config");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");
const appModules = path.resolve(projectRoot, "node_modules");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo so Metro can read packages/core/src.
config.watchFolders = [monorepoRoot];

// Note the ordering: metro-resolver (resolve.js:140-153) walks up from the
// importing file FIRST and appends context.nodeModulesPaths LAST, so this is the
// last place consulted for anything imported from outside the app, not the first.
// That is exactly why packages/core's own node_modules used to win, and why the
// redirect below is needed rather than relying on this.
config.resolver.nodeModulesPaths = [appModules];

/** The package a bare specifier belongs to ("lib0/buffer" -> "lib0"), or null. */
const packageOf = (moduleName) => {
  if (!moduleName || moduleName.startsWith(".") || path.isAbsolute(moduleName)) return null;
  const parts = moduleName.split("/");
  return moduleName.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

// Packages that must resolve to the app's single copy. yjs and y-websocket are
// direct dependencies of packages/core; lib0 and y-protocols arrive transitively
// through them. All four also exist inside the pnpm store (.pnpm/yjs@*/node_modules/
// lib0 and friends), so resolution originating anywhere outside this app finds a
// second copy on its own and never falls back.
//
// All four are declared dependencies of this app, y-protocols explicitly so that
// npm installs it rather than leaving it to hoisting out of y-websocket's tree.
// Still filtered by what is present: if a copy is ever missing, fall through to
// normal resolution instead of redirecting at a path that is not there.
const shared = new Set(
  ["yjs", "lib0", "y-websocket", "y-protocols"].filter((name) =>
    fs.existsSync(path.join(appModules, name)),
  ),
);

// Browser-only modules that need a React Native stand-in. This has to happen in
// resolveRequest rather than extraNodeModules: packages/core has its own
// node_modules/y-indexeddb (a pnpm symlink), so normal resolution succeeds and a
// fallback never runs. extraNodeModules only applies when resolution FAILS.
const substitutes = {
  "y-indexeddb": path.resolve(projectRoot, "src/shims/y-indexeddb.js"),
};

// Re-resolving from a file inside the app makes the hierarchical walk reach
// apps/mobile/node_modules first. Rewriting to an absolute path would also dedupe,
// but an absolute specifier takes resolve.js:45 into resolveModulePath and never
// reaches resolvePackage, the only place package exports are honoured. That is
// inert while unstable_enablePackageExports is false (SDK 52) and wrong as soon as
// it is on: lib0 ships a dedicated "react-native" condition for webcrypto.
const appOrigin = path.join(projectRoot, "index.ts");

const defaultResolveRequest = config.resolver.resolveRequest;
const delegate = (context, moduleName, platform) =>
  (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const substitute = substitutes[moduleName];
  if (substitute) return delegate(context, substitute, platform);

  const pkg = packageOf(moduleName);
  if (pkg && shared.has(pkg) && !context.originModulePath?.startsWith(projectRoot + path.sep)) {
    // Bare specifier preserved, so subpaths ("lib0/buffer") and exports both work.
    return delegate({ ...context, originModulePath: appOrigin }, moduleName, platform);
  }

  return delegate(context, moduleName, platform);
};

module.exports = config;
