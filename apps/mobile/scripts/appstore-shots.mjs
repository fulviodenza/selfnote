#!/usr/bin/env node
// App Store screenshots, reproducibly, against a throwaway local Selfnote.
//
//   node scripts/appstore-shots.mjs all            every preset
//   node scripts/appstore-shots.mjs ipad13         one preset
//   node scripts/appstore-shots.mjs all --build    rebuild the app first
//   node scripts/appstore-shots.mjs all --keep     leave the demo stack running
//
// The demo instance: Postgres 16 in Docker (container selfnote-shots-pg on port
// 15432, since 5432 is often taken), plus selfnote-api on 4445 and selfnote-sync
// on 4444 built with cargo from this checkout. The Simulator shares the host's
// network, so the app reaches them on 127.0.0.1. Nothing here touches a real
// instance or real data.
//
// The demo account (demo@selfnote.app, password generated once into
// scripts/fixtures/demo-credentials.json, gitignored) is filled through the
// public API by tools/mcp-server/scripts/seed-demo.mjs, which writes note
// bodies the way the MCP server does. Reruns reuse the account and skip pages
// that already exist.
//
// Per preset: find or create the simulator, boot it, install the Release build,
// override the status bar, then shoot each screen. The app is steered by
// Documents/.screenshot-tour.json (see src/tour.ts) rather than by synthetic
// taps, which do not reliably reach the Simulator: the tour names the server,
// the demo login and the screen to open. Every PNG's pixel size is checked
// against what App Store Connect accepts for the bucket; a mismatch fails the
// run. Output goes to screenshots/<preset>/, gitignored.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "../..");
const mcpRoot = join(repoRoot, "tools/mcp-server");
const outRoot = join(appRoot, "screenshots");
const credsFile = join(here, "fixtures", "demo-credentials.json");
const stackFile = join(outRoot, ".stack.json");
const BUNDLE = "app.selfnote.mobile";
const APP = join(appRoot, "ios/build/sim/Build/Products/Release-iphonesimulator/Selfnote.app");
const DT = "com.apple.CoreSimulator.SimDeviceType.";

const PG = { name: "selfnote-shots-pg", port: 15432 };
const DATABASE_URL = `postgres://selfnote:selfnote@127.0.0.1:${PG.port}/selfnote`;
const API_PORT = 4445;
const SYNC_PORT = 4444;
const SERVER = {
  apiUrl: `http://127.0.0.1:${API_PORT}`,
  syncUrl: `ws://127.0.0.1:${SYNC_PORT}/ws`,
};
const DEMO_EMAIL = "demo@selfnote.app";
const MEETING_NOTE = "Website relaunch kickoff";

const PRESETS = {
  ipad13: {
    deviceTypes: [
      "iPad-Pro-13-inch-M5-12GB",
      "iPad-Pro-13-inch-M5-16GB",
      "iPad-Pro-13-inch-M4-8GB",
      "iPad-Pro-13-inch-M4-16GB",
    ],
    sizes: [
      [2064, 2752],
      [2048, 2732],
    ],
  },
  "iphone-di-medium": {
    deviceTypes: ["iPhone-16-Pro", "iPhone-16", "iPhone-15-Pro"],
    sizes: [
      [1206, 2622],
      [1179, 2556],
    ],
    // The phone listing carries the list and the editor; graph and tasks are
    // the iPad's story.
    shots: ["01-home", "02-note"],
  },
};

// Seconds to let each screen settle before the shot. Generous on purpose: each
// launch signs in, loads the workspace and, for a note, starts the WebView
// editor and syncs the document over the socket.
const SHOTS = [
  { name: "01-home", open: "home", wait: 10 },
  { name: "02-note", open: { note: MEETING_NOTE }, wait: 15 },
  { name: "03-graph", open: "graph", wait: 14 },
  { name: "04-tasks", open: "tasks", wait: 10 },
];

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log("[shots]", ...a);
/** Thrown, not exited on the spot, so cleanup still runs: a tour file left
 * behind would steer every later launch of the app, and the servers would
 * outlive the run. */
class ShotsError extends Error {}
const fail = (msg) => {
  throw new ShotsError(msg);
};

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
}
const simctl = (...args) => run("xcrun", ["simctl", ...args]);
/** For the calls whose failure is a normal state (terminate a stopped app,
 * boot a booted device). */
const simctlQuiet = (...args) => spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" });

/* ----------------------------------------------------------- the stack --- */

async function healthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(what, check, seconds) {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return;
    await sleep(1);
  }
  fail(`${what} did not come up within ${seconds}s`);
}

/** True when anything at all accepts a TCP connection on the port. */
function portTaken(port) {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (taken) => {
      sock.destroy();
      resolve(taken);
    };
    sock.setTimeout(1500, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** docker run or start, with a port clash turned into a plain refusal. */
function docker(args) {
  try {
    return run("docker", args);
  } catch (e) {
    const msg = String(e.stderr ?? e.message);
    if (/port is already allocated|address already in use/i.test(msg)) {
      fail(
        `port ${PG.port} is taken, so ${PG.name} cannot start; another container ` +
          `(selfnote-tmp-pg, for one, maps it) is probably running: stop it and rerun`,
      );
    }
    throw e;
  }
}

/** Start the Postgres container if needed, recording on `stack` that this run
 * started it before waiting on it, so a failed wait still stops it. */
async function ensurePostgres(stack) {
  const state = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", PG.name], { encoding: "utf8" });
  if (state.error) fail("docker is not available");
  if (state.status !== 0) {
    log(`creating ${PG.name} on port ${PG.port}`);
    docker([
      "run", "-d", "--name", PG.name,
      "-e", "POSTGRES_USER=selfnote", "-e", "POSTGRES_PASSWORD=selfnote", "-e", "POSTGRES_DB=selfnote",
      "-p", `127.0.0.1:${PG.port}:5432`,
      "postgres:16",
    ]);
    stack.pgStarted = true;
  } else if (state.stdout.trim() !== "true") {
    log(`starting ${PG.name}`);
    docker(["start", PG.name]);
    stack.pgStarted = true;
  }
  await waitFor(
    "Postgres",
    () =>
      spawnSync("docker", ["exec", PG.name, "pg_isready", "-U", "selfnote", "-d", "selfnote", "-h", "127.0.0.1"])
        .status === 0,
    60,
  );
}

function readStack() {
  try {
    return JSON.parse(readFileSync(stackFile, "utf8"));
  } catch {
    return null;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The command line of a process, or "" when it is gone. */
const commandOf = (pid) => spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

/**
 * Whether the servers a --keep run left behind are really ours and really on
 * the shots database: the recorded pids must still be this checkout's
 * selfnote-api and selfnote-sync, and the API must sign the demo account in
 * as the very user id the shots Postgres holds for it.
 */
async function ownStack(kept) {
  const [api, sync] = kept?.pids ?? [];
  if (!api || !sync || !alive(api) || !alive(sync)) return false;
  if (!commandOf(api).endsWith("target/debug/selfnote-api")) return false;
  if (!commandOf(sync).endsWith("target/debug/selfnote-sync")) return false;
  if (!existsSync(credsFile)) return false;
  const creds = JSON.parse(readFileSync(credsFile, "utf8"));
  const inDb = spawnSync(
    "docker",
    ["exec", PG.name, "psql", "-U", "selfnote", "-d", "selfnote", "-tAc", `select id from users where email = '${creds.email.replace(/'/g, "''")}'`],
    { encoding: "utf8" },
  ).stdout?.trim();
  if (!inDb) return false;
  try {
    const res = await fetch(`${SERVER.apiUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(creds),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok && (await res.json()).user_id === inDb;
  } catch {
    return false;
  }
}

function launchServer(stack, bin, env, logName) {
  const fd = openSync(join(outRoot, logName), "w");
  const child = spawn(join(repoRoot, "target/debug", bin), [], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  child.unref();
  // Recorded at once, so cleanup reaches it even if its health wait fails.
  stack.pids.push(child.pid);
}

/**
 * Bring up the demo stack on `stack`, which the caller tears down whatever
 * happens. A stack left by an earlier --keep run is reused only when it proves
 * to be ours; anything else on the ports is refused, so the demo data can
 * never land in a development database.
 */
async function startStack(stack) {
  mkdirSync(outRoot, { recursive: true });
  await ensurePostgres(stack);

  const kept = readStack();
  if (kept && (await ownStack(kept))) {
    log(`reusing the demo servers from a --keep run (pids ${kept.pids.join(", ")})`);
    stack.pids.push(...kept.pids);
    // Whoever started the container first owns stopping it.
    stack.pgStarted ||= kept.pgStarted === true;
    return;
  }
  rmSync(stackFile, { force: true });
  for (const [what, port] of [["API", API_PORT], ["sync", SYNC_PORT]]) {
    if (await portTaken(port)) {
      fail(`something is already listening on ${port} (${what}); stop it so the demo stack can use the port`);
    }
  }

  log("building selfnote-api and selfnote-sync");
  const cargo = spawnSync("cargo", ["build", "-p", "selfnote-api", "-p", "selfnote-sync"], {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (cargo.status !== 0) fail("cargo build failed");

  const common = { DATABASE_URL, ROOM_SECRET: "shotroom", RUST_LOG: "info" };
  // The API applies the migrations on boot, so it goes first.
  launchServer(stack, "selfnote-api", { ...common, JWT_SECRET: "shotsecret", API_ADDR: `127.0.0.1:${API_PORT}` }, "api.log");
  await waitFor("selfnote-api", () => healthy(`${SERVER.apiUrl}/healthz`), 90);
  launchServer(stack, "selfnote-sync", { ...common, SYNC_ADDR: `127.0.0.1:${SYNC_PORT}` }, "sync.log");
  await waitFor("selfnote-sync", () => healthy(`http://127.0.0.1:${SYNC_PORT}/healthz`), 60);
  log(`stack up: api ${SERVER.apiUrl}, sync ${SERVER.syncUrl} (logs in screenshots/)`);
}

function stopStack(stack, keep) {
  if (keep) {
    writeFileSync(stackFile, JSON.stringify({ pids: stack.pids, pgStarted: stack.pgStarted }));
    log(`--keep: leaving the demo stack running (pids ${stack.pids.join(", ")}, ${PG.name})`);
    return;
  }
  for (const pid of stack.pids) {
    try {
      process.kill(pid, "SIGINT");
    } catch {
      /* already gone */
    }
  }
  rmSync(stackFile, { force: true });
  if (stack.pgStarted) {
    log(`stopping ${PG.name}`);
    spawnSync("docker", ["stop", PG.name], { stdio: "ignore" });
  }
}

/* ---------------------------------------------------------------- seed --- */

function credentials() {
  if (existsSync(credsFile)) return JSON.parse(readFileSync(credsFile, "utf8"));
  const creds = { email: DEMO_EMAIL, password: randomBytes(18).toString("base64url") };
  mkdirSync(dirname(credsFile), { recursive: true });
  writeFileSync(credsFile, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  log(`generated the demo password into ${credsFile.replace(appRoot + "/", "")}`);
  return creds;
}

function seed(creds) {
  log("building tools/mcp-server (the seeder writes note bodies with its edit pipeline)");
  const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: mcpRoot, stdio: "inherit" });
  if (tsc.status !== 0) fail("tools/mcp-server did not build");
  const res = spawnSync(
    "node",
    [join(mcpRoot, "scripts/seed-demo.mjs"), SERVER.apiUrl, creds.email, creds.password],
    { cwd: mcpRoot, stdio: "inherit" },
  );
  if (res.status === 3) {
    fail(
      `${creds.email} exists in ${PG.name} with a different password than ` +
        `${credsFile.replace(appRoot + "/", "")} holds: restore that file, or remove the ` +
        `container (docker rm -f ${PG.name}) to start over with a fresh account`,
    );
  }
  if (res.status !== 0) fail("seeding the demo workspace failed");
}

/* ----------------------------------------------------------- simulators --- */

function runtimeVersion(key) {
  const m = /iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(key);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3] ?? 0) : -1;
}

function findOrCreateDevice(preset) {
  const { devices } = JSON.parse(simctl("list", "devices", "-j", "available"));
  for (const type of preset.deviceTypes) {
    const matches = [];
    for (const [runtime, list] of Object.entries(devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const d of list) {
        if (d.deviceTypeIdentifier === DT + type && d.isAvailable !== false) {
          matches.push({ ...d, runtime });
        }
      }
    }
    if (!matches.length) continue;
    // A booted one first, so a run does not boot a second copy; then the
    // newest runtime.
    matches.sort(
      (a, b) =>
        Number(b.state === "Booted") - Number(a.state === "Booted") ||
        runtimeVersion(b.runtime) - runtimeVersion(a.runtime),
    );
    return { udid: matches[0].udid, name: matches[0].name, runtime: matches[0].runtime };
  }
  const { runtimes } = JSON.parse(simctl("list", "runtimes", "-j", "available"));
  const ios = runtimes
    .filter((r) => r.platform === "iOS" || r.identifier.includes("iOS"))
    .sort((a, b) => runtimeVersion(b.identifier) - runtimeVersion(a.identifier));
  if (!ios.length) fail("no iOS simulator runtime installed");
  const { devicetypes } = JSON.parse(simctl("list", "devicetypes", "-j"));
  for (const type of preset.deviceTypes) {
    const dt = devicetypes.find((d) => d.identifier === DT + type);
    if (!dt) continue;
    const name = `Selfnote ${dt.name}`;
    const udid = simctl("create", name, dt.identifier, ios[0].identifier).trim();
    log(`created ${name} on ${ios[0].name}`);
    return { udid, name, runtime: ios[0].identifier };
  }
  fail(`none of these device types is installed: ${preset.deviceTypes.join(", ")}`);
}

function boot(udid) {
  simctlQuiet("boot", udid);
  simctl("bootstatus", udid, "-b");
}

/* ---------------------------------------------------------------- build --- */

function build() {
  const logFile = join(outRoot, "build.log");
  mkdirSync(outRoot, { recursive: true });
  log(`building the Release simulator app (log: ${logFile})`);
  const fd = openSync(logFile, "w");
  const res = spawnSync(
    "xcodebuild",
    [
      "-workspace", "Selfnote.xcworkspace",
      "-scheme", "Selfnote",
      "-configuration", "Release",
      "-sdk", "iphonesimulator",
      "-arch", "arm64",
      "-derivedDataPath", "./build/sim",
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    { cwd: join(appRoot, "ios"), stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  if (res.status !== 0 || !existsSync(APP)) fail(`xcodebuild failed, see ${logFile}`);
}

/* ---------------------------------------------------------------- shots --- */

function pngSize(file) {
  const out = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const w = /pixelWidth: (\d+)/.exec(out);
  const h = /pixelHeight: (\d+)/.exec(out);
  if (!w || !h) fail(`sips could not read the size of ${file}`);
  return [Number(w[1]), Number(h[1])];
}

/** A shot's pixels, read from a BMP copy because node has no PNG decoder. */
function pixels(file) {
  const bmp = file.replace(/\.png$/, ".check.bmp");
  try {
    run("sips", ["-s", "format", "bmp", file, "--out", bmp]);
    const b = readFileSync(bmp);
    return {
      b,
      offset: b.readUInt32LE(10),
      width: b.readInt32LE(18),
      height: Math.abs(b.readInt32LE(22)),
      bytes: b.readUInt16LE(28) / 8,
    };
  } finally {
    rmSync(bmp, { force: true });
  }
}

/**
 * The share of sampled pixels that differ between two shots. Every screen
 * the tour opens looks nothing like the others, so two shots that barely
 * differ mean the tour did not reach its screen (a note title that matched
 * nothing, a load that had not finished) and the app sat on the list.
 */
function difference(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const row = Math.ceil((a.width * a.bytes) / 4) * 4;
  let n = 0;
  let differ = 0;
  for (let y = 0; y < a.height; y += 4) {
    for (let x = 0; x < a.width; x += 4) {
      const i = y * row + x * a.bytes;
      const pa = a.offset + i;
      const pb = b.offset + i;
      n++;
      if (
        Math.abs(a.b[pa] - b.b[pb]) > 24 ||
        Math.abs(a.b[pa + 1] - b.b[pb + 1]) > 24 ||
        Math.abs(a.b[pa + 2] - b.b[pb + 2]) > 24
      ) differ++;
    }
  }
  return differ / n;
}

async function launchFresh(udid) {
  simctlQuiet("terminate", udid, BUNDLE);
  await sleep(1);
  simctl("launch", udid, BUNDLE);
}

async function runPreset(name, creds) {
  const preset = PRESETS[name];
  const dev = findOrCreateDevice(preset);
  log(`${name}: ${dev.name} ${dev.udid} (${dev.runtime.split(".").pop()})`);
  boot(dev.udid);

  simctlQuiet("terminate", dev.udid, BUNDLE);
  simctl("install", dev.udid, APP);
  const container = simctl("get_app_container", dev.udid, BUNDLE, "data").trim();
  const tourFile = join(container, "Documents", ".screenshot-tour.json");
  mkdirSync(dirname(tourFile), { recursive: true });
  simctlQuiet("ui", dev.udid, "appearance", "light");
  simctl(
    "status_bar", dev.udid, "override",
    "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100",
    "--dataNetwork", "wifi", "--wifiBars", "3",
    "--cellularMode", "active", "--cellularBars", "4", "--operatorName", "",
  );

  const outDir = join(outRoot, name);
  // Fresh each run, so a shot a preset no longer takes does not linger.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const results = [];
  const taken = [];
  try {
    for (const shot of SHOTS.filter((s) => !preset.shots || preset.shots.includes(s.name))) {
      writeFileSync(
        tourFile,
        JSON.stringify({ server: SERVER, login: { email: creds.email, password: creds.password }, open: shot.open }),
      );
      const file = join(outDir, `${shot.name}.png`);
      for (let attempt = 1; ; attempt++) {
        await launchFresh(dev.udid);
        await sleep(shot.wait + (attempt - 1) * 5);
        simctl("io", dev.udid, "screenshot", "--type=png", file);
        pngSize(file);
        const px = pixels(file);
        const twin = taken.find((t) => difference(t.px, px) < 0.02);
        if (!twin) {
          taken.push({ name: shot.name, px });
          break;
        }
        if (attempt === 3) {
          fail(`${shot.name} looks the same as ${twin.name}: the tour did not reach its screen (${file})`);
        }
        log(`${shot.name}: looks like ${twin.name}, retaking (${attempt})`);
      }
      const [w, h] = pngSize(file);
      const ok = preset.sizes.some(([aw, ah]) => aw === w && ah === h);
      results.push({ preset: name, file, w, h, ok });
      log(`${shot.name}: ${w}x${h} ${ok ? "accepted" : "NOT ACCEPTED"}`);
    }
  } finally {
    // Leave the device usable by hand: no tour steering the next launch and
    // the real status bar back. The app stays signed in to the demo account
    // on purpose, so the next run starts warm; Settings or reinstalling resets it.
    rmSync(tourFile, { force: true });
    simctlQuiet("terminate", dev.udid, BUNDLE);
    simctlQuiet("status_bar", dev.udid, "clear");
  }
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    printTable(results);
    fail(
      `${bad.length} screenshot(s) at a size App Store Connect will not take for ${name} ` +
        `(wants ${preset.sizes.map(([w, h]) => `${w}x${h}`).join(" or ")})`,
    );
  }
  return results;
}

function printTable(rows) {
  const lines = [["preset", "file", "size", "accepted"], ...rows.map((r) => [r.preset, r.file.replace(appRoot + "/", ""), `${r.w}x${r.h}`, r.ok ? "yes" : "no"])];
  const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  for (const l of lines) console.log(l.map((c, i) => c.padEnd(widths[i])).join("  "));
}

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const stack = { pgStarted: false, pids: [] };
let ok = false;
try {
  const target = args.find((a) => !a.startsWith("--")) ?? "all";
  const names = target === "all" ? Object.keys(PRESETS) : [target];
  for (const n of names) {
    if (!PRESETS[n]) fail(`unknown preset ${n}; one of: all, ${Object.keys(PRESETS).join(", ")}`);
  }
  if (args.includes("--build") || !existsSync(APP)) build();
  await startStack(stack);
  const creds = credentials();
  seed(creds);
  const all = [];
  for (const n of names) all.push(...(await runPreset(n, creds)));
  printTable(all);
  ok = true;
} catch (err) {
  if (!(err instanceof ShotsError)) throw err;
  console.error("[shots] FAILED:", err.message);
  process.exitCode = 1;
} finally {
  // A failed run never leaves servers behind, --keep or not.
  stopStack(stack, keep && ok);
}
