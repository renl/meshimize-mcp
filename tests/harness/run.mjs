// SDET finite container harness. No application code, host services or production access.
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
const home = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = resolve(home, "../../../..");
const mode = process.argv[2] ?? "baseline";
if (!["baseline", "wire", "suite"].includes(mode)) throw Error("Use baseline, wire or suite");
const candidate = "a93478e67ad67802f0ea09cb2693733487f98bb3";
const run = `meshimize-mcp03-${randomUUID().slice(0, 8)}`;
const out = join(root, "_build/sdet-local/runs", run);
const context = join(out, "context");
mkdirSync(context, { recursive: true });
const env = { ...process.env, DOCKER_CONFIG: join(root, "_build/sdet-local/docker") };
mkdirSync(env.DOCKER_CONFIG, { recursive: true });
const label = "meshimize.sdet.run",
  containers = [],
  images = [],
  volumes = [];
let network,
  assertion = "BLOCKED",
  cleanup = "NOT_RUN",
  failure;
const evidence = {
  run,
  mode,
  candidate,
  clientBaseline: "54492ad914a4e164a9cd53987c0b8b247fc89bf6",
  clientCandidate: process.env.MCP_TEST_CANDIDATE ?? "54492ad914a4e164a9cd53987c0b8b247fc89bf6",
  files: {},
};
const start = Date.now();
function cmd(command, args, seconds = 60, allow = false) {
  const remaining = 900000 - (Date.now() - start);
  if (remaining <= 0 && !allow) throw Error("Total 900s deadline");
  const r = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout: allow ? seconds * 1000 : Math.min(seconds * 1000, remaining),
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.status !== 0 && !allow) {
    writeFileSync(join(out, `failure-${Date.now()}.log`), text);
    throw Error(`${command} ${args[0]} failed; run-local log retained`);
  }
  return { ok: r.status === 0, text, value: (r.stdout ?? "").trim() };
}
const docker = (args, seconds = 60, allow = false) => cmd("docker", args, seconds, allow);
function create(name, args) {
  const id = docker([
    "create",
    "--name",
    `${run}-${name}`,
    "--label",
    `${label}=${run}`,
    ...args,
  ]).value;
  containers.push(id);
  return id;
}
function space(stage, minimumKiB = 1048576) {
  const name = `${run}-space`;
  let text;
  try {
    text = docker(
      [
        "run",
        "--name",
        name,
        "--label",
        `${label}=${run}`,
        "--pull=never",
        "--read-only",
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--entrypoint",
        "sh",
        "sha256:7b81cc2be4a88b22648ef83e459f19a364cbbd25ebea2c5563146bd1c489cb2a",
        "-c",
        "df -k /",
      ],
      10,
    ).value;
  } finally {
    if (!docker(["rm", "-f", name], 10, true).ok || docker(["inspect", name], 5, true).ok)
      throw Error("Space probe cleanup failed");
  }
  const availableKiB = Number(text.trim().split("\n").at(-1).trim().split(/\s+/)[3]);
  (evidence.space ??= []).push({ stage, availableKiB, at: new Date().toISOString() });
  writeFileSync(join(out, "space.json"), JSON.stringify(evidence.space, null, 2));
  if (!Number.isFinite(availableKiB) || availableKiB < minimumKiB)
    throw Error(`Capacity stop at ${stage}: ${availableKiB}KiB; need ${minimumKiB}KiB`);
}
async function build(tag, path, extra = []) {
  space(`before-${tag}`);
  images.push(tag);
  const fd = openSync(join(out, `${tag}-build.log`), "w");
  try {
    await new Promise((resolveBuild, rejectBuild) => {
      const child = spawn(
        "docker",
        [
          "build",
          "--network=none",
          "--progress=plain",
          "--label",
          `${label}=${run}`,
          ...extra,
          "-t",
          tag,
          path,
        ],
        { env, stdio: ["ignore", fd, fd] },
      );
      let stopped;
      const stop = (reason) => {
        if (stopped) return;
        stopped = reason;
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10000 });
        else child.kill("SIGTERM");
      };
      const timer = setTimeout(
        () => stop("Build deadline"),
        Math.min(600000, 900000 - (Date.now() - start)),
      );
      const monitor = setInterval(() => {
        try {
          space(`during-${tag}`);
        } catch (e) {
          stop(e.message);
        }
      }, 10000);
      const finish = (error) => {
        clearTimeout(timer);
        clearInterval(monitor);
        if (error) rejectBuild(error);
        else resolveBuild();
      };
      child.once("error", finish);
      child.once("exit", (code) =>
        finish(
          stopped || code !== 0
            ? Error(stopped ?? `Build exit ${code}; see run-local build log`)
            : null,
        ),
      );
    });
  } finally {
    closeSync(fd);
  }
  space(`after-${tag}`);
}
function hash(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) hash(p);
    else
      evidence.files[relative(context, p)] = createHash("sha256")
        .update(readFileSync(p))
        .digest("hex");
  }
}
try {
  docker(["version", "--format", "{{.Server.Version}}"]);
  const cache = "meshimize-mcp03a-npm-cache:lock-0f067763c8fa";
  const cacheId = "sha256:087c27e4186b0d7e036534a6b16c36f4f2f7b9bd128f3fc33d985ba93589a535";
  if (docker(["image", "inspect", cache, "--format", "{{.Id}}"]).value !== cacheId)
    throw Error("Dependency image drift/missing");
  if (
    cmd("git", ["-C", root, "rev-parse", "feature/private-group-joining"]).value !== candidate ||
    cmd("git", ["-C", home, "rev-parse", "HEAD"]).value !== evidence.clientCandidate
  )
    throw Error("Pinned baseline drift");
  cmd("git", [
    "-C",
    home,
    "merge-base",
    "--is-ancestor",
    evidence.clientBaseline,
    evidence.clientCandidate,
  ]);
  cmd("git", [
    "-C",
    home,
    "diff",
    "--exit-code",
    "HEAD",
    "--",
    "src",
    "package.json",
    "package-lock.json",
  ]);
  // Conservative incremental budget: client/base/export 1GiB, server build/cache/export
  // 2GiB, disposable DB/runtime 0.5GiB, plus 1GiB untouched safety reserve.
  space("preflight-estimate-4.5GiB", 4718592);
  const client = join(context, "client");
  mkdirSync(client);
  for (const path of [
    "src",
    "tests",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
  ])
    cpSync(join(home, path), join(client, path), { recursive: true });
  hash(context);
  writeFileSync(
    join(client, "Dockerfile"),
    `FROM ${cache}\nWORKDIR /proof\nCOPY package*.json ./\nRUN npm ci --ignore-scripts --no-audit --no-fund\nCOPY . .\nRUN npm run build\n`,
  );
  await build(`${run}-client`, client);
  if (mode === "baseline") {
    const provenance = join(root, "_build/sdet-local/server-cache-03a");
    const manifest = readFileSync(join(provenance, "source-manifest.json"));
    const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    const provision = JSON.parse(readFileSync(join(provenance, "result.json"), "utf8"));
    const tag = "meshimize-mcp03a-server:a93478e";
    const imageId = "sha256:4a77a71f0e3290f0158bd94362db48abe6b7d2eb0c8cc15eaf6195307b6f55d3";
    if (
      manifestSha256 !== "da24f7469e6c8b1990ec45fcf49bc1f4ab5c6555efbe1dc4e3a6f1de4ef1c690" ||
      provision.source !== candidate ||
      provision.manifestSha256 !== manifestSha256 ||
      provision.imageId !== imageId ||
      provision.snapshotVerified !== true ||
      provision.sourceFiles !== 1837 ||
      Object.keys(JSON.parse(manifest)).length !== 1837 ||
      docker(["image", "inspect", tag, "--format", "{{.Id}}"]).value !== imageId
    )
      throw Error("Exact server fixture source/image provenance drift");
    evidence.serverFixture = { imageId, tag, source: candidate, manifestSha256 };
    space("before-disposable-runtime");
    network = docker(["network", "create", "--label", `${label}=${run}`, run]).value;
    const db = create("db", [
      "--network",
      run,
      "--network-alias",
      "db",
      "-e",
      "POSTGRES_PASSWORD=disposable",
      "-e",
      "POSTGRES_DB=meshimize_mcp03",
      "postgres:16",
    ]);
    const mounts = JSON.parse(docker(["inspect", "--format", "{{json .Mounts}}", db]).value);
    volumes.push(...mounts.filter((m) => m.Type === "volume").map((m) => m.Name));
    docker(["start", db]);
    let ready = false;
    for (let i = 0; i < 30; i++) {
      if (docker(["exec", db, "pg_isready", "-U", "postgres"], 3, true).ok) {
        ready = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    if (!ready) throw Error("DB readiness deadline");
    const appArgs = [
      "--network",
      run,
      "-e",
      "DATABASE_URL=ecto://postgres:disposable@db/meshimize_mcp03",
      "-e",
      `SECRET_KEY_BASE=${randomUUID().repeat(3)}`,
      "-e",
      "PHX_HOST=localhost",
      "-e",
      "MESHIMIZE_RUNTIME_ENV=test",
      evidence.serverFixture.imageId,
    ];
    const migrate = create("migrate", [
      ...appArgs,
      "/app/bin/meshimize",
      "eval",
      "Meshimize.Release.migrate()",
    ]);
    docker(["start", "-a", migrate], 90);
    const app = create("server", appArgs);
    docker(["start", app]);
    evidence.serverImage = docker(["inspect", "--format", "{{.Image}}", app]).value;
    const test = create("baseline", [
      "--network",
      `container:${app}`,
      "-e",
      "TEST_DISPOSABLE_ENV=true",
      `${run}-client`,
      "node",
      "--test",
      "tests/harness/baseline.mjs",
    ]);
    const r = docker(["start", "-a", test], 180, true);
    writeFileSync(join(out, "baseline.log"), r.text);
    assertion =
      r.ok && docker(["inspect", "--format", "{{.State.ExitCode}}", test]).value === "0"
        ? "PASS"
        : "FAIL";
  } else {
    const test = create("wire", [
      `${run}-client`,
      "npx",
      "--no-install",
      "vitest",
      "run",
      ...(mode === "wire" ? ["tests/join-wire.test.ts"] : []),
      "--maxWorkers",
      "1",
      "--minWorkers",
      "1",
    ]);
    const r = docker(["start", "-a", test], 60, true);
    writeFileSync(join(out, "wire.log"), r.text);
    assertion =
      r.ok && docker(["inspect", "--format", "{{.State.ExitCode}}", test]).value === "0"
        ? "PASS"
        : "FAIL";
  }
  hash(context);
} catch (e) {
  failure = e.message;
} finally {
  let clean = true;
  for (const id of containers.reverse()) {
    if (assertion !== "PASS") {
      const state = docker(["inspect", "--format", "{{json .State}}", id], 10, true);
      const logs = docker(["logs", "--tail", "60", id], 10, true);
      writeFileSync(join(out, `container-${id.slice(0, 12)}.log`), `${state.value}\n${logs.text}`);
    }
    const owner = docker(
      ["inspect", "--format", `{{index .Config.Labels "${label}"}}`, id],
      15,
      true,
    );
    if (!owner.ok || owner.value !== run) {
      clean = false;
      continue;
    }
    if (!docker(["rm", "-f", "-v", id], 30, true).ok || docker(["inspect", id], 10, true).ok)
      clean = false;
  }
  if (network && !docker(["network", "rm", network], 30, true).ok) clean = false;
  for (const tag of images) {
    const owner = docker(
      ["image", "inspect", "--format", `{{index .Config.Labels "${label}"}}`, tag],
      15,
      true,
    );
    if (owner.ok && (owner.value !== run || !docker(["image", "rm", tag], 30, true).ok))
      clean = false;
  }
  for (const v of volumes) if (docker(["volume", "inspect", v], 10, true).ok) clean = false;
  for (const type of ["container", "network", "volume"]) {
    const r = docker(
      [
        ...(type === "container" ? ["ps", "-aq"] : [type, "ls", "-q"]),
        "--filter",
        `label=${label}=${run}`,
      ],
      15,
      true,
    );
    if (!r.ok || r.value) clean = false;
  }
  cleanup = clean ? "PASS" : "FAIL";
  try {
    space("after-cleanup", 0);
  } catch (e) {
    cleanup = "FAIL";
    failure ??= e.message;
  }
  Object.assign(evidence, { assertion, cleanup, failure, volumes });
  writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({ run, assertion, cleanup, failure, evidence: join(out, "evidence.json") }),
  );
  process.exitCode = assertion === "PASS" && cleanup === "PASS" ? 0 : 1;
}
