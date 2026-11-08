import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  PACKAGE,
  REPOSITORY,
  HttpError,
  NPM_CLI,
  NPM_ROOT,
  assertNpmEntries,
  assertNpmManifest,
  assertPackageIdentity,
  assertTarballManifest,
  compareVersions,
  ensureGitHubRelease,
  finishRelease,
  publishArgs,
  publishRelease,
  registryVersion,
  releaseBody,
  sri,
  tarballFiles,
  tarballName,
  validateRelease,
  verifyRelease,
} from "../release-sdk.mjs";

const commit = "a".repeat(40);
const integrity = "sha512-test-package-integrity";
const release = {
  schemaVersion: 1,
  package: PACKAGE,
  version: "1.2.0",
  source: { repository: "glamsystems/glam", commit: "b".repeat(40) },
  notes: "## SDK 1.2.0\n\nApproved changes.",
  commit,
  tag: "v1.2.0",
};
const metadata = {
  name: PACKAGE,
  version: release.version,
  gitHead: commit,
  repository: { url: `git+https://github.com/${REPOSITORY}.git` },
  dist: {
    integrity,
    signatures: [{ keyid: "test-registry-key" }],
    attestations: {
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  },
};

function validationInput() {
  const pkg = {
    name: PACKAGE,
    version: release.version,
    repository: { url: `https://github.com/${REPOSITORY}.git` },
  };
  return {
    marker: structuredClone(release),
    pkg,
    lock: { ...pkg, packages: { "": { ...pkg } } },
    ref: `refs/tags/${release.tag}`,
    commit,
    repository: REPOSITORY,
  };
}

test("valid release records bind private source, public tag, package and lock", () => {
  assert.equal(validateRelease(validationInput()).commit, commit);
  // The publishConfig the mirror's package.json carries passes.
  const input = validationInput();
  input.pkg.publishConfig = { access: "public" };
  assert.equal(validateRelease(input).commit, commit);
});

for (const [description, publishConfig] of [
  [
    "a scoped registry",
    { "@glamsystems:registry": "https://registry.example.invalid/" },
  ],
  ["access public and another key", { access: "public", tag: "next" }],
  ["another access", { access: "restricted" }],
])
  test(`release validation rejects a publishConfig with ${description}`, () => {
    const input = validationInput();
    input.pkg.publishConfig = publishConfig;
    assert.throws(
      () => validateRelease(input),
      /package\.json may carry no publishConfig other than access public/,
    );
  });

for (const [description, change] of [
  [
    "branch dispatch",
    (input) => {
      input.ref = "refs/heads/main";
    },
  ],
  [
    "wrong tag",
    (input) => {
      input.ref = "refs/tags/v1.2.1";
    },
  ],
  [
    "another repository",
    (input) => {
      input.repository = "fork/glam-sdk-ts";
    },
  ],
  [
    "unknown metadata schema",
    (input) => {
      input.marker.schemaVersion = 2;
    },
  ],
  [
    "wrong source repository",
    (input) => {
      input.marker.source.repository = "fork/glam";
    },
  ],
  [
    "short source SHA",
    (input) => {
      input.marker.source.commit = "abc1234";
    },
  ],
  [
    "package version mismatch",
    (input) => {
      input.pkg.version = "1.2.1";
    },
  ],
  [
    "lock version mismatch",
    (input) => {
      input.lock.version = "1.2.1";
    },
  ],
  [
    "lock root mismatch",
    (input) => {
      input.lock.packages[""].version = "1.2.1";
    },
  ],
  [
    "missing notes",
    (input) => {
      input.marker.notes = " ";
    },
  ],
  [
    "prerelease",
    (input) => {
      input.marker.version = "1.2.0-test";
    },
  ],
  [
    "a package.json that already carries gitHead",
    (input) => {
      input.pkg.gitHead = commit;
    },
  ],
]) {
  test(`release validation rejects ${description}`, () => {
    const input = validationInput();
    change(input);
    assert.throws(() => validateRelease(input));
  });
}

test("only registry 404 means absent; server and auth errors stay errors", async () => {
  assert.equal(
    await registryVersion(
      "1.2.0",
      async () => new Response("", { status: 404 }),
    ),
    null,
  );
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(
      registryVersion("1.2.0", async () => new Response("", { status })),
      (error) => error.status === status,
    );
  }
  await assert.rejects(
    registryVersion("1.2.0", async () => {
      throw new TypeError("network offline");
    }),
  );
  assert.deepEqual(
    await registryVersion("1.2.0", async () => Response.json(metadata)),
    metadata,
  );
});

test("immutable version identity requires exact commit and bytes", () => {
  assertPackageIdentity(metadata, release, integrity);
  for (const change of [
    { name: "another-package" },
    { version: "1.1.2" },
    { gitHead: "c".repeat(40) },
    { dist: { integrity: "sha512-other" } },
    { repository: { url: "https://github.com/fork/glam-sdk-ts" } },
  ])
    assert.throws(() =>
      assertPackageIdentity({ ...metadata, ...change }, release, integrity),
    );
});

function scenario(overrides = {}) {
  const calls = [];
  let published = false;
  let latest = { version: "1.1.2" };
  const options = {
    release,
    integrity,
    lookup: async () => (published ? metadata : null),
    latest: async () => latest,
    publish: async () => {
      calls.push("publish");
      published = true;
      latest = metadata;
    },
    verify: async () => {
      calls.push("verify");
    },
    finalize: async () => {
      calls.push("finalize");
    },
    delay: async () => {
      calls.push("delay");
    },
    attempts: 3,
    ...overrides,
  };
  return { calls, options };
}

// The publish, verify and finish jobs in the order the workflow runs them.
async function runJobs(options) {
  await publishRelease(options);
  await verifyRelease(options);
  await finishRelease(options);
}

test("absent version publishes once, verifies, then finalizes", async () => {
  const { calls, options } = scenario();
  await runJobs(options);
  assert.deepEqual(calls, ["publish", "verify", "finalize"]);
});

test("matching existing version completes without publication and preserves newer latest", async () => {
  const { calls, options } = scenario({
    lookup: async () => metadata,
    latest: async () => ({ version: "1.3.0" }),
  });
  await runJobs(options);
  assert.deepEqual(calls, ["verify", "finalize"]);
});

test("a conflicting existing version never publishes or finalizes", async () => {
  const { calls, options } = scenario({
    lookup: async () => ({ ...metadata, gitHead: "c".repeat(40) }),
  });
  await assert.rejects(runJobs(options), /source commit differs/);
  assert.deepEqual(calls, []);
});

test("failed initial lookup does not authorize publication", async () => {
  const { calls, options } = scenario({
    lookup: async () => {
      throw new HttpError(503, "Unavailable");
    },
  });
  await assert.rejects(runJobs(options), /Unavailable/);
  assert.deepEqual(calls, []);
});

test("a new older version cannot regress npm latest", async () => {
  const { calls, options } = scenario({
    latest: async () => ({ version: "1.3.0" }),
  });
  await assert.rejects(runJobs(options), /older version/);
  assert.deepEqual(calls, []);
});

test("fresh lookups retry visibility and transient errors after publication", async () => {
  let count = 0;
  const { calls, options } = scenario({
    lookup: async () => {
      count++;
      if (count <= 2) return null;
      if (count === 3) throw new HttpError(503, "Unavailable");
      return metadata;
    },
  });
  await runJobs(options);
  assert.deepEqual(calls, ["publish", "delay", "delay", "verify", "finalize"]);
});

test("a lost publish response can complete by verifying the exact registry version", async () => {
  let published = false;
  const { calls, options } = scenario({
    lookup: async () => (published ? metadata : null),
    latest: async () => (published ? metadata : { version: "1.1.2" }),
    publish: async () => {
      published = true;
      throw new Error("Response lost");
    },
  });
  await runJobs(options);
  assert.deepEqual(calls, ["verify", "finalize"]);
});

test("failed post-publish verification reruns without publishing again", async () => {
  let verifications = 0;
  const { calls, options } = scenario({
    verify: async () => {
      verifications++;
      if (verifications === 1)
        throw new Error("Registry signature service unavailable");
    },
  });
  await assert.rejects(runJobs(options), /signature service/);
  assert.deepEqual(calls, ["publish"]);
  await runJobs(options);
  assert.deepEqual(calls, ["publish", "finalize"]);
});

test("exhausted publication visibility does not finalize", async () => {
  const { calls, options } = scenario({ lookup: async () => null });
  await assert.rejects(runJobs(options), /did not become visible/);
  assert.deepEqual(calls, ["publish", "delay", "delay"]);
});

test("missing provenance cannot complete a release", async () => {
  const { calls, options } = scenario({
    lookup: async () => ({
      ...metadata,
      dist: { integrity, signatures: [{}] },
    }),
  });
  await assert.rejects(runJobs(options), /provenance is missing/);
  assert.deepEqual(calls, []);
});

test("each job does only its own part: publish never verifies or finalizes, verify never publishes or finalizes", async () => {
  const { calls, options } = scenario();
  await publishRelease(options);
  assert.deepEqual(calls, ["publish"]);
  await verifyRelease(options);
  assert.deepEqual(calls, ["publish", "verify"]);
  await finishRelease(options);
  assert.deepEqual(calls, ["publish", "verify", "finalize"]);
});

test("finish refuses an npm latest behind the release and a registry tarball that differs", async () => {
  for (const overrides of [
    {
      lookup: async () => metadata,
      latest: async () => ({ version: "1.1.2" }),
    },
    { lookup: async () => metadata, latest: async () => null },
    {
      lookup: async () => ({
        ...metadata,
        dist: { ...metadata.dist, integrity: "sha512-other" },
      }),
      latest: async () => metadata,
    },
  ]) {
    const { calls, options } = scenario(overrides);
    await assert.rejects(finishRelease(options));
    assert.deepEqual(calls, []);
  }
});

test("version comparison is numeric and rejects invalid latest tags", () => {
  assert.equal(compareVersions("1.10.0", "1.2.0"), 1);
  assert.equal(compareVersions("1.2.0", "2.0.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.throws(() => compareVersions("1.2.0-test", "1.2.0"));
});

function githubScenario({ existing = null, taggedCommit = commit } = {}) {
  const writes = [];
  const request = async (path, options = {}) => {
    if (path.includes("/git/ref/"))
      return { object: { type: "commit", sha: taggedCommit } };
    if (path.includes("/releases/tags/")) return existing;
    assert.equal(options.method, "POST");
    writes.push(options.body);
    return options.body;
  };
  return { request, writes };
}

test("release creation binds exact tag, source and approved notes", async () => {
  const { request, writes } = githubScenario();
  await ensureGitHubRelease(release, request);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target_commitish, commit);
  assert.equal(writes[0].tag_name, release.tag);
  assert.equal(writes[0].body, releaseBody(release));
  assert.equal(writes[0].draft, false);
  assert.equal(writes[0].prerelease, false);
  assert.equal(writes[0].make_latest, "legacy");
});

test("matching completed release is idempotent", async () => {
  const { request, writes } = githubScenario({
    existing: {
      tag_name: release.tag,
      target_commitish: commit,
      body: releaseBody(release),
      draft: false,
      prerelease: false,
    },
  });
  await ensureGitHubRelease(release, request);
  assert.deepEqual(writes, []);
});

test("moved tags and conflicting releases are never overwritten", async () => {
  for (const input of [
    { taggedCommit: "c".repeat(40) },
    { existing: { tag_name: release.tag, target_commitish: "main" } },
    {
      existing: {
        tag_name: release.tag,
        target_commitish: commit,
        body: "Unrelated release",
      },
    },
  ]) {
    const { request, writes } = githubScenario(input);
    await assert.rejects(ensureGitHubRelease(release, request));
    assert.deepEqual(writes, []);
  }
});

const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));
const CHECK_BUNDLE = join(SCRIPTS, "check-bundle.mjs");
const RELEASE_SDK = join(SCRIPTS, "release-sdk.mjs");
const REQUIRED = `require("${PACKAGE}")`;
const IMPORTED = `import("${PACKAGE}/index.esm.js")`;
const KEPT = "StateModel keeps every field its parent assigns";
// The fields the StateIdlModel constructor assigns, in the order the check
// names them.
const ASSIGNED = [
  "accountType",
  "name",
  "uri",
  "enabled",
  "oracleConfigs",
  "assets",
  "created",
  "owner",
  "portfolioManagerName",
  "borrowable",
  "timelockDuration",
  "integrationAcls",
  "delegateAcls",
];
// The fields StateModel 1.2.0 declared again. Its constructor assigns the
// last two itself, so the first eight are the ones a consumer lost.
const REDECLARED = [
  "accountType",
  "name",
  "enabled",
  "assets",
  "created",
  "owner",
  "portfolioManagerName",
  "timelockDuration",
  "integrationAcls",
  "delegateAcls",
];
const LOST = `StateModel lost ${REDECLARED.slice(0, 8).join(", ")}`;

// One entry of a miniature SDK. A field in `redeclared` is a class field of
// the subclass: it is defined after super() returns, which resets what the
// parent's constructor assigned. The subclass constructor assigns three
// fields itself, as the SDK's does, unless `reassigns` is false.
function entry(format, redeclared = [], reassigns = true) {
  const body = `
class StateIdlModel {
  constructor(data) {
    for (const field of ${JSON.stringify(ASSIGNED)})
      this[field] = data[field] ?? null;
  }
}
class StateModel extends StateIdlModel {
  ${redeclared.map((field) => `${field};`).join("\n  ")}
  constructor(data) {
    super(data);${
      reassigns
        ? `
    this.borrowable = data.borrowable ?? null;
    this.integrationAcls = data.integrationAcls ?? [];
    this.delegateAcls = data.delegateAcls ?? [];`
        : ""
    }
  }
}
const StateAccountType = {
  VAULT: { vault: {} },
  equals: (a, b) => Object.keys(a)[0] === Object.keys(b)[0],
};
`;
  return format === "cjs"
    ? `require("bundle-dependency");${body}module.exports = { StateModel, StateAccountType };\n`
    : `import "bundle-dependency";${body}export { StateModel, StateAccountType };\n`;
}

// A built package root: both entries, the files a release must pack, the
// build's scratch directory, and a dependency only the root's node_modules
// holds.
function builtPackage(t, { cjs = entry("cjs"), esm = entry("esm") } = {}) {
  const root = mkdtempSync(join(tmpdir(), "glam-sdk-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = { name: PACKAGE, version: release.version };
  const files = {
    "package.json": JSON.stringify({
      ...identity,
      main: "./index.cjs.js",
      module: "./index.esm.js",
      types: "./index.cjs.d.ts",
      repository: { url: `https://github.com/${REPOSITORY}.git` },
      files: ["index.*", "target"],
      publishConfig: { access: "public" },
    }),
    "package-lock.json": JSON.stringify({
      ...identity,
      packages: { "": identity },
    }),
    ".sdk-release.json": JSON.stringify({
      schemaVersion: release.schemaVersion,
      package: release.package,
      version: release.version,
      source: release.source,
      notes: release.notes,
    }),
    "index.cjs.js": cjs,
    "index.esm.js": esm,
    "index.cjs.d.ts": "",
    "index.esm.d.ts": "",
    "target/idl/glam_protocol.json": "{}",
    "target/types/glam_protocol.ts": "",
    ".build/types/index.d.ts": "",
    "node_modules/bundle-dependency/package.json": JSON.stringify({
      name: "bundle-dependency",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/bundle-dependency/index.js": "",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

// Every child reads and writes the fixture alone. Git is bound to the
// fixture's own repository, whatever repository or hook the tests run from,
// and npm packs without the network or the user's cache.
function run(program, args, root, env = {}) {
  const inherited = Object.entries(process.env).filter(
    ([name]) => !name.startsWith("GIT_"),
  );
  return spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(inherited),
      GIT_DIR: join(root, ".git"),
      GIT_WORK_TREE: root,
      npm_config_cache: join(root, ".npm-cache"),
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      ...env,
    },
  });
}

test("the bundle check passes a packed bundle whose StateModel keeps its inherited fields", (t) => {
  const root = builtPackage(t);
  const result = run(process.execPath, [CHECK_BUNDLE], root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${REQUIRED}: ${KEPT}\n`), result.stdout);
  assert.ok(result.stdout.includes(`${IMPORTED}: ${KEPT}\n`), result.stdout);
  // The scratch consumer and its tarball are gone.
  assert.deepEqual(readdirSync(join(root, ".build")), ["types"]);
});

for (const [format, label, broken, intact] of [
  ["cjs", "CommonJS", REQUIRED, IMPORTED],
  ["esm", "ES module", IMPORTED, REQUIRED],
])
  test(`the bundle check refuses class fields that reset what the parent assigned in the ${label} entry`, (t) => {
    const root = builtPackage(t, { [format]: entry(format, REDECLARED) });
    const result = run(process.execPath, [CHECK_BUNDLE], root);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`${broken}: ${LOST}\n`), result.stderr);
    assert.ok(
      result.stderr.includes(
        `${broken}: StateAccountType.equals(model.accountType, StateAccountType.VAULT) threw: `,
      ),
      result.stderr,
    );
    assert.ok(!result.stderr.includes(`${intact}: `), result.stderr);
    assert.equal(result.stdout, `${intact}: ${KEPT}\n`);
    assert.match(
      result.stderr,
      /glamsystems-glam-sdk-1\.2\.0\.tgz fails the bundle check\./,
    );
  });

test("the bundle check compares every field the parent assigns", (t) => {
  // Every field declared again and none reassigned: all thirteen are lost.
  const root = builtPackage(t, {
    cjs: entry("cjs", ASSIGNED, false),
    esm: entry("esm", ASSIGNED, false),
  });
  const result = run(process.execPath, [CHECK_BUNDLE], root);
  assert.equal(result.status, 1, result.stdout);
  const all = `StateModel lost ${ASSIGNED.join(", ")}`;
  assert.ok(result.stderr.includes(`${REQUIRED}: ${all}\n`), result.stderr);
  assert.ok(result.stderr.includes(`${IMPORTED}: ${all}\n`), result.stderr);
});

test("the bundle check refuses an entry that lacks the state model or fails to load", (t) => {
  const root = builtPackage(t, {
    cjs: "module.exports = {};\n",
    esm: 'export {};\nthrow new Error("entry failed to load");\n',
  });
  const result = run(process.execPath, [CHECK_BUNDLE], root);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(
    result.stderr.includes(
      `${REQUIRED}: StateModel or StateAccountType is not exported\n`,
    ),
    result.stderr,
  );
  assert.ok(
    result.stderr.includes(
      `${IMPORTED}: could not be checked: Error: entry failed to load\n`,
    ),
    result.stderr,
  );
  assert.equal(result.stdout, "");
});

test("the bundle check judges the tarball it is given, not the files beside it", (t) => {
  const root = builtPackage(t, {
    cjs: entry("cjs", REDECLARED),
    esm: entry("esm", REDECLARED),
  });
  const packed = run("npm", ["pack", "--ignore-scripts", "--json"], root);
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  writeFileSync(join(root, "index.cjs.js"), entry("cjs"));
  writeFileSync(join(root, "index.esm.js"), entry("esm"));
  const given = run(process.execPath, [CHECK_BUNDLE, filename], root);
  assert.equal(given.status, 1, given.stdout);
  assert.ok(given.stderr.includes(`${REQUIRED}: ${LOST}\n`), given.stderr);
  assert.ok(given.stderr.includes(`${IMPORTED}: ${LOST}\n`), given.stderr);
  // Without a tarball it packs the files as they are now.
  const repacked = run(process.execPath, [CHECK_BUNDLE], root);
  assert.equal(repacked.status, 0, repacked.stderr);
});

// A tagged checkout of the built package, as each release job checks it out.
function taggedCheckout(t, entries) {
  const root = builtPackage(t, entries);
  const git = (...args) => {
    const result = run("git", args, root);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("add", "-A");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "release",
  );
  git("-c", "tag.gpgsign=false", "tag", release.tag);
  const head = git("rev-parse", "HEAD");
  // Where the jobs keep what is not the checkout: the pack, the outputs and
  // the stand-ins' records.
  const outside = mkdtempSync(join(tmpdir(), "glam-sdk-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  return {
    root,
    head,
    outside,
    pkg: JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    env: {
      GITHUB_REF: `refs/tags/${release.tag}`,
      GITHUB_SHA: head,
      GITHUB_REPOSITORY: REPOSITORY,
    },
  };
}

// One script mode in the checkout. With stand-ins, npm on PATH records each
// call and fetch answers for the registry and the GitHub API.
function mode(
  checkout,
  name,
  env = {},
  { standIns = false, recordNpm = false } = {},
) {
  const state = join(checkout.outside, "state");
  mkdirSync(state, { recursive: true });
  const preload = join(checkout.outside, "stand-in-fetch.mjs");
  const bin = join(checkout.outside, "bin");
  if (standIns) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm"), STAND_IN_NPM);
    chmodSync(join(bin, "npm"), 0o755);
    writeFileSync(preload, STAND_IN_FETCH);
  }
  const recorder = join(checkout.outside, "record-npm.mjs");
  if (recordNpm) writeFileSync(recorder, RECORD_NPM);
  return run(
    process.execPath,
    [
      ...(standIns ? ["--import", pathToFileURL(preload).href] : []),
      ...(recordNpm ? ["--import", pathToFileURL(recorder).href] : []),
      RELEASE_SDK,
      name,
    ],
    checkout.root,
    {
      ...checkout.env,
      STAND_IN_STATE: state,
      STAND_IN_HEAD: checkout.head,
      ...(standIns && { PATH: `${bin}:${process.env.PATH}` }),
      ...env,
    },
  );
}

const records = (checkout, file) => {
  const path = join(checkout.outside, "state", file);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
};

const STAND_IN_NPM = `#!/bin/sh
printf '%s\\n' "$*" >> "$STAND_IN_STATE/npm"
case "$1" in
  publish)
    printf '%s %s\\n' "$PWD" "$(ls -A)" >> "$STAND_IN_STATE/publish-directory"
    touch "$STAND_IN_STATE/published" ;;
  install)
    mkdir -p "node_modules/$STAND_IN_PACKAGE"
    printf '{"name":"%s","version":"1.2.0"}\\n' "$STAND_IN_PACKAGE" > "node_modules/$STAND_IN_PACKAGE/package.json"
    echo 'exports.getGlamProtocolProgramId = () => "program";' > "node_modules/$STAND_IN_PACKAGE/index.js"
    printf '{"packages":{"node_modules/%s":{"integrity":"%s"}}}\\n' "$STAND_IN_PACKAGE" "\${STAND_IN_LOCK_INTEGRITY:-$RELEASE_INTEGRITY}" > package-lock.json ;;
  audit) echo "1 package has a verified registry signature" ;;
  *) echo "unexpected npm $*" >&2; exit 2 ;;
esac
`;

// Records each npm run as this Node and runs it unchanged.
const RECORD_NPM = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const forward = childProcess.execFileSync;
childProcess.execFileSync = (file, args = [], options) => {
  if (file === process.execPath && args[0]?.endsWith("/bin/npm-cli.js"))
    appendFileSync(join(process.env.STAND_IN_STATE, "npm-cli"), file + " " + args[0] + " " + args[1] + "\\n");
  return forward(file, args, options);
};
syncBuiltinESMExports();
`;

const STAND_IN_FETCH = `import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const state = process.env.STAND_IN_STATE;
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
// npm run as this Node goes to the npm stand-in on PATH, and is recorded.
const forward = childProcess.execFileSync;
childProcess.execFileSync = (file, args = [], options) => {
  if (file === process.execPath && args[0]?.endsWith("/bin/npm-cli.js")) {
    appendFileSync(join(state, "npm-cli"), file + " " + args[0] + "\\n");
    return forward("npm", args.slice(1), options);
  }
  return forward(file, args, options);
};
syncBuiltinESMExports();
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const { host, pathname } = new URL(url);
  appendFileSync(join(state, "requests"), method + " " + host + pathname + "\\n");
  if (host === "registry.npmjs.org") {
    if (pathname.endsWith("/latest"))
      return Response.json({ version: process.env.STAND_IN_LATEST ?? "1.1.2" });
    if (!existsSync(join(state, "published")) && !process.env.STAND_IN_PUBLISHED)
      return new Response("", { status: 404 });
    return Response.json({
      name: "${PACKAGE}",
      version: "${release.version}",
      gitHead: process.env.STAND_IN_HEAD,
      repository: { url: "git+https://github.com/${REPOSITORY}.git" },
      dist: {
        integrity: process.env.RELEASE_INTEGRITY,
        signatures: [{ keyid: "test-registry-key" }],
        attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
      },
    });
  }
  if (host === "api.github.com" && process.env.STAND_IN_GITHUB === "allow") {
    if (pathname.endsWith("/git/ref/tags/${release.tag}"))
      return Response.json({ object: { type: "commit", sha: process.env.STAND_IN_HEAD } });
    if (pathname.endsWith("/releases/tags/${release.tag}")) return new Response("", { status: 404 });
    if (method === "POST" && pathname.endsWith("/releases")) return Response.json(JSON.parse(init.body));
  }
  throw new Error("refused request: " + method + " " + url);
};
`;

// The pack mode in the checkout, with the real npm and the outputs file.
function packMode(t, entries) {
  const checkout = taggedCheckout(t, entries);
  const output = join(checkout.outside, "output");
  const pack = join(checkout.outside, "pack");
  const result = mode(
    checkout,
    "pack",
    { RELEASE_PACK_DIR: pack, GITHUB_OUTPUT: output },
    { recordNpm: true },
  );
  const outputs = existsSync(output)
    ? Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => [
            line.slice(0, line.indexOf("=")),
            line.slice(line.indexOf("=") + 1),
          ]),
      )
    : {};
  return { checkout, result, outputs, pack };
}

test("the pack mode stops at a misbehaving bundle and reports no tarball", (t) => {
  const { result, outputs } = packMode(t, {
    cjs: entry("cjs", REDECLARED),
    esm: entry("esm", REDECLARED),
  });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(`${REQUIRED}: ${LOST}\n`), result.stderr);
  assert.ok(result.stderr.includes(`${IMPORTED}: ${LOST}\n`), result.stderr);
  assert.match(
    result.stderr,
    /glamsystems-glam-sdk-1\.2\.0\.tgz failed the bundle check\. This run published nothing\./,
  );
  assert.deepEqual(outputs, {});
});

test("the pack mode writes gitHead into the tarball, checks the bundle, then reports the tarball and its integrity", (t) => {
  const { checkout, result, outputs, pack } = packMode(t);
  assert.equal(result.status, 0, result.stderr);
  // npm pack ran the npm whose modules the checks load.
  assert.deepEqual(records(checkout, "npm-cli"), [
    `${process.execPath} ${NPM_CLI} pack`,
  ]);
  assert.ok(result.stdout.includes(`${REQUIRED}: ${KEPT}\n`), result.stdout);
  assert.ok(result.stdout.includes(`${IMPORTED}: ${KEPT}\n`), result.stdout);
  assert.equal(outputs.tarball, tarballName(release.version));
  const bytes = readFileSync(join(pack, outputs.tarball));
  assert.equal(outputs.integrity, sri(bytes));
  const files = tarballFiles(bytes);
  assert.deepEqual(JSON.parse(files.get("package/package.json")), {
    ...checkout.pkg,
    gitHead: checkout.head,
  });
  assertTarballManifest(files, checkout.pkg, checkout.head);
  // The checkout keeps its committed package.json.
  assert.deepEqual(
    JSON.parse(readFileSync(join(checkout.root, "package.json"), "utf8")),
    checkout.pkg,
  );
  assert.equal(
    JSON.parse(readFileSync(join(pack, "release-pack.json"), "utf8")).integrity,
    outputs.integrity,
  );
});

test("npm takes gitHead from git for a directory and from package.json for a tarball", async (t) => {
  // npm's own readers, from the npm that runs these tests. pnpm run sets
  // npm_config_prefix to the package directory, and npm root -g follows it.
  const root = execFileSync("npm", ["root", "-g"], {
    encoding: "utf8",
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^npm_config_|^prefix$/i.test(name),
      ),
    ),
  }).trim();
  const npmRequire = createRequire(join(root, "npm", "package.json"));
  const pacote = npmRequire("pacote");
  const PackageJson = npmRequire("@npmcli/package-json");
  const { checkout, outputs, pack } = packMode(t);
  // A cache outside any repository, as a runner's is.
  const cache = mkdtempSync(join(tmpdir(), "glam-sdk-npm-cache-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const directory = await PackageJson.prepare(checkout.root);
  assert.equal(directory.content.gitHead, checkout.head);
  const plain = join(checkout.outside, "plain");
  mkdirSync(plain);
  const packed = run(
    "npm",
    ["pack", "--ignore-scripts", "--json", `--pack-destination=${plain}`],
    checkout.root,
  );
  assert.equal(packed.status, 0, packed.stderr);
  const manifest = (file) =>
    pacote.manifest(`file:${file}`, { fullReadJson: true, cache });
  const without = await manifest(join(plain, tarballName(release.version)));
  assert.equal(without.gitHead, undefined);
  const written = await manifest(join(pack, outputs.tarball));
  assert.equal(written.gitHead, checkout.head);
});

// A packed checkout and the env the publish job gives the publish mode.
function packedRelease(t) {
  const { checkout, result, outputs, pack } = packMode(t);
  assert.equal(result.status, 0, result.stderr);
  return {
    checkout,
    tarball: join(pack, outputs.tarball),
    env: {
      RELEASE_TARBALL: join(pack, outputs.tarball),
      RELEASE_INTEGRITY: outputs.integrity,
    },
  };
}

test("the publish mode publishes the tarball path with fixed flags from an empty directory and nothing else", (t) => {
  const { checkout, tarball, env } = packedRelease(t);
  const result = mode(checkout, "publish", env, { standIns: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(records(checkout, "npm"), [publishArgs(tarball).join(" ")]);
  assert.deepEqual(publishArgs(tarball), [
    "publish",
    tarball,
    "--ignore-scripts",
    "--access",
    "public",
    "--provenance",
    "--tag",
    "latest",
    "--registry=https://registry.npmjs.org",
    "--@glamsystems:registry=https://registry.npmjs.org/",
  ]);
  // The directory and its listing, which is empty.
  const [directory] = records(checkout, "publish-directory");
  assert.match(directory, /\/glam-sdk-publish-[^\s/]+$/);
  assert.ok(!directory.startsWith(checkout.root), directory);
  const requests = records(checkout, "requests");
  assert.deepEqual(requests, [
    `GET registry.npmjs.org/${encodeURIComponent(PACKAGE)}/1.2.0`,
    "GET registry.npmjs.org/%40glamsystems%2Fglam-sdk/latest",
    `GET registry.npmjs.org/${encodeURIComponent(PACKAGE)}/1.2.0`,
  ]);
});

test("the publish mode settles an existing matching version by identity and publishes nothing", (t) => {
  const { checkout, env } = packedRelease(t);
  const result = mode(
    checkout,
    "publish",
    { ...env, STAND_IN_PUBLISHED: "1" },
    { standIns: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already matches this release/);
  assert.deepEqual(records(checkout, "npm"), []);
});

// A POSIX ustar entry, or a pax header when type is "x". magic is the eight
// bytes of magic and version, prefix the ustar prefix field and linkpath the
// link target.
function tarEntry(
  path,
  content,
  type = "0",
  { magic = "ustar\u000000", prefix = "", linkpath = "" } = {},
) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path.slice(0, 100), 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(linkpath, 157);
  header.write(magic, 257, "latin1");
  header.write(prefix, 345);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function paxHeader(key, value) {
  const tail = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(tail);
  length += String(length + String(length).length).length;
  return tarEntry("PaxHeader", `${length}${tail}`, "x");
}

const gzippedTar = (...entries) =>
  gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

// The entry with `text` written at `offset` of its header and the checksum
// recomputed.
function patchedHeader(entry, offset, text) {
  const patched = Buffer.from(entry);
  patched.write(text, offset, "latin1");
  patched.write("        ", 148);
  const sum = patched.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  patched.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return patched;
}

// A 100 byte pax path record whose length field is `digits`.
const paxLength = (digits) => {
  const head = `${digits} path=package/`;
  return tarEntry(
    "PaxHeader",
    `${head}${"x".repeat(100 - head.length - 1)}\n`,
    "x",
  );
};

for (const digits of ["1e2", "0x64", "0100", "99", "101"])
  test(`this reader refuses a pax record whose length field is ${digits}, which npm's tar module drops`, () => {
    assert.throws(
      () =>
        tarballFiles(gzippedTar(paxLength(digits), tarEntry("package/a", ""))),
      /The tarball has a malformed extended header/,
    );
  });

test("this reader takes a pax record whose length field is its decimal byte count", () => {
  const files = tarballFiles(
    gzippedTar(paxLength("100"), tarEntry("package/a", "")),
  );
  assert.deepEqual([...files.keys()], [`package/${"x".repeat(82)}`]);
});

// A pax header of one record whose key and value are bytes.
function paxBytes(key, value) {
  const tail = Buffer.concat([
    Buffer.from(" "),
    Buffer.from(key),
    Buffer.from("="),
    Buffer.from(value),
    Buffer.from("\n"),
  ]);
  let length = tail.length;
  length += String(length + String(length).length).length;
  return tarEntry(
    "PaxHeader",
    Buffer.concat([Buffer.from(String(length)), tail]),
    "x",
  );
}

for (const [description, header] of [
  [
    "a path value that is not valid UTF-8",
    paxBytes("path", Buffer.from([...Buffer.from("package/b"), 0xff])),
  ],
  ["a newline inside its key", paxBytes("pa\nth", "package/b")],
])
  test(`this reader refuses a pax record with ${description}`, () => {
    assert.throws(
      () => tarballFiles(gzippedTar(header, tarEntry("package/a", ""))),
      /The tarball has a malformed extended header/,
    );
  });

for (const [description, offset, text] of [
  ["a byte 475 that is not 0 after a short prefix", 475, "a"],
  ["an access time after a prefix of 130 bytes or fewer", 476, "00000000001"],
  ["a byte after the prefix field", 500, "a"],
])
  test(`this reader refuses a ustar header with ${description}, which npm pack does not write`, () => {
    const entry = patchedHeader(
      tarEntry("a.json", "{}", "0", { prefix: "package" }),
      offset,
      text,
    );
    assert.throws(
      () => tarballFiles(gzippedTar(entry)),
      /The tarball has a ustar header with bytes after its prefix that npm pack does not write/,
    );
  });

test("this reader reads a prefix of 155 bytes when byte 475 is not 0, as npm's tar module does", async () => {
  const prefix = `package/${"d".repeat(140)}`;
  const entry = tarEntry("a.json", "{}", "0", { prefix });
  assert.notEqual(entry[475], 0);
  const files = tarballFiles(gzippedTar(entry));
  assert.deepEqual([...files.keys()], [`${prefix}/a.json`]);
  await assertNpmEntries(gzippedTar(entry));
});

// The checkout's package.json as the pack mode writes it, changed by `change`.
const manifestOf = (checkout, change = (pkg) => pkg) =>
  JSON.stringify(change({ ...checkout.pkg, gitHead: checkout.head }));

// Publishes a crafted tarball under the release's file name, with its real
// integrity, so the refusal comes from the rule under test alone.
function publishCrafted(t, bytes, envChange = {}) {
  const checkout = taggedCheckout(t);
  mkdirSync(join(checkout.outside, "crafted"));
  const tarball = join(
    checkout.outside,
    "crafted",
    tarballName(release.version),
  );
  writeFileSync(tarball, typeof bytes === "function" ? bytes(checkout) : bytes);
  const env = {
    RELEASE_TARBALL: tarball,
    RELEASE_INTEGRITY: sri(readFileSync(tarball)),
    ...envChange,
  };
  const result = mode(checkout, "publish", env, { standIns: true });
  // Every refusal comes before the first registry request.
  assert.deepEqual(records(checkout, "npm"), []);
  assert.deepEqual(records(checkout, "requests"), []);
  return result;
}

// A change the build job could make to the published manifest.
const evil = (pkg) => ({
  ...pkg,
  publishConfig: { registry: "https://registry.example.invalid/" },
});

// The checkout's packed package.json, then the given entries.
const afterPackageJson = (checkout, ...entries) =>
  gzippedTar(
    tarEntry("package/package.json", manifestOf(checkout)),
    ...entries,
  );

// A GNU header whose bytes at the ustar prefix field read package/gnu. npm's
// tar module applies no prefix to it and reads package/package.json.
const gnuPackageJson = (checkout) =>
  tarEntry("package/package.json", manifestOf(checkout, evil), "0", {
    magic: "ustar  \0",
    prefix: "package/gnu",
  });

const crafted = (change) => (checkout) =>
  gzippedTar(
    tarEntry("package/package.json", manifestOf(checkout, change)),
    tarEntry("package/index.cjs.js", ""),
  );

test("a crafted tarball with exactly the packed package.json passes every check before the registry", (t) => {
  const checkout = taggedCheckout(t);
  const tarball = join(checkout.outside, tarballName(release.version));
  writeFileSync(tarball, crafted()(checkout));
  const result = mode(
    checkout,
    "publish",
    { RELEASE_TARBALL: tarball, RELEASE_INTEGRITY: sri(readFileSync(tarball)) },
    { standIns: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(records(checkout, "npm"), [publishArgs(tarball).join(" ")]);
  // Publish ran the npm whose modules the checks load.
  assert.deepEqual(records(checkout, "npm-cli"), [
    `${process.execPath} ${NPM_CLI}`,
  ]);
});

for (const [description, change] of [
  ["a changed field", (pkg) => ({ ...pkg, description: "changed" })],
  [
    "a publishConfig the build job added",
    (pkg) => ({
      ...pkg,
      publishConfig: { registry: "https://registry.example.invalid/" },
    }),
  ],
  ["another name", (pkg) => ({ ...pkg, name: "@glamsystems/other" })],
  ["another version", (pkg) => ({ ...pkg, version: "1.2.1" })],
  ["another gitHead", (pkg) => ({ ...pkg, gitHead: "c".repeat(40) })],
  ["no gitHead", ({ gitHead, ...pkg }) => pkg],
  [
    "another repository",
    (pkg) => ({
      ...pkg,
      repository: { url: "https://github.com/fork/glam-sdk-ts.git" },
    }),
  ],
])
  test(`the publish mode refuses a tarball whose package.json has ${description}`, (t) => {
    const result = publishCrafted(t, crafted(change));
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      /The tarball's package\.json is not this commit's package\.json with gitHead added/,
    );
  });

for (const [description, tarball, message] of [
  [
    "a second package.json",
    (checkout) =>
      gzippedTar(
        tarEntry("package/package.json", manifestOf(checkout)),
        tarEntry(
          "package/package.json",
          manifestOf(checkout, (pkg) => ({ ...pkg, private: true })),
        ),
      ),
    /holds package\/package\.json twice/,
  ],
  [
    "a pax header that renames an entry to package.json",
    (checkout) =>
      gzippedTar(
        tarEntry("package/package.json", manifestOf(checkout)),
        paxHeader("path", "package/package.json"),
        tarEntry("package/other.json", "{}"),
      ),
    /holds package\/package\.json twice/,
  ],
  [
    "an entry outside package/",
    (checkout) =>
      gzippedTar(
        tarEntry("package/package.json", manifestOf(checkout)),
        tarEntry("other/package.json", "{}"),
      ),
    /holds other\/package\.json, which is outside package\//,
  ],
  [
    "a symbolic link",
    (checkout) =>
      gzippedTar(
        tarEntry("package/package.json", manifestOf(checkout)),
        tarEntry("package/link", "", "2"),
      ),
    /holds package\/link, which is not a regular file/,
  ],
  [
    "no package.json",
    () => gzippedTar(tarEntry("package/index.cjs.js", "")),
    /The tarball has no package\/package\.json/,
  ],
  // npm's tar module reads this entry as a second package/package.json.
  [
    "a GNU header after the POSIX package.json",
    (checkout) => afterPackageJson(checkout, gnuPackageJson(checkout)),
    /The tarball has a header that is not POSIX ustar$/m,
  ],
  [
    "a ustar version other than 00",
    (checkout) =>
      afterPackageJson(
        checkout,
        tarEntry("package/package.json", manifestOf(checkout, evil), "0", {
          magic: "ustar\u000001",
          prefix: "package/old",
        }),
      ),
    /The tarball has a ustar header whose version is not 00/,
  ],
  [
    "a pax path that the prefix field extends to package/package.json",
    (checkout) =>
      afterPackageJson(
        checkout,
        paxHeader("path", "package.json"),
        tarEntry("package/other.json", manifestOf(checkout, evil), "0", {
          prefix: "package",
        }),
      ),
    /The tarball holds package\/package\.json twice/,
  ],
  [
    "a pax path with a newline, which npm's tar module skips",
    (checkout) =>
      afterPackageJson(
        checkout,
        paxHeader("path", "package/other\n.json"),
        tarEntry("package/package.json", manifestOf(checkout, evil)),
      ),
    /The tarball has a malformed extended header/,
  ],
  [
    "a binding.gyp, for which npm adds an install script",
    (checkout) =>
      afterPackageJson(checkout, tarEntry("package/binding.gyp", "{}")),
    /npm reads a package\.json from the tarball that is not this commit's package\.json with gitHead added/,
  ],
])
  test(`the publish mode refuses a tarball with ${description}`, (t) => {
    const result = publishCrafted(t, tarball);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  });

for (const [description, env, message] of [
  [
    "an integrity that differs from the tarball's",
    { RELEASE_INTEGRITY: sri(Buffer.from("another tarball")) },
    /The tarball differs from the one the build job reported/,
  ],
  [
    "a malformed integrity",
    { RELEASE_INTEGRITY: "sha512-abc" },
    /RELEASE_INTEGRITY is not a sha512 integrity/,
  ],
  [
    "an integrity of another algorithm",
    { RELEASE_INTEGRITY: `sha1-${"A".repeat(27)}=` },
    /RELEASE_INTEGRITY is not a sha512 integrity/,
  ],
  [
    "no integrity",
    { RELEASE_INTEGRITY: "" },
    /RELEASE_INTEGRITY is not a sha512 integrity/,
  ],
])
  test(`the publish mode refuses ${description}`, (t) => {
    const result = publishCrafted(t, crafted(), env);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
  });

test("the publish mode refuses a tarball inside the checkout or under another name", (t) => {
  for (const [place, message] of [
    [
      (checkout) => join(checkout.root, tarballName(release.version)),
      /must be outside the checkout/,
    ],
    [
      (checkout) => join(checkout.outside, "glamsystems-glam-sdk-1.2.1.tgz"),
      /does not name this release's tarball/,
    ],
  ]) {
    const checkout = taggedCheckout(t);
    const tarball = place(checkout);
    writeFileSync(tarball, crafted()(checkout));
    const result = mode(
      checkout,
      "publish",
      {
        RELEASE_TARBALL: tarball,
        RELEASE_INTEGRITY: sri(readFileSync(tarball)),
      },
      { standIns: true },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
    assert.deepEqual(records(checkout, "npm"), []);
  }
});

// A stand-in for a checkout, for the checks that read no git.
const plain = {
  pkg: {
    name: PACKAGE,
    version: release.version,
    repository: { url: `https://github.com/${REPOSITORY}.git` },
  },
  head: commit,
};

test("the checks load npm's modules from the npm bundled with this Node", () => {
  assert.equal(
    JSON.parse(readFileSync(join(NPM_ROOT, "package.json"), "utf8")).name,
    "npm",
  );
  // Pack and publish run it, and the npm on PATH, which verifies, is that npm.
  for (const [program, args] of [
    [process.execPath, [NPM_CLI, "--version"]],
    ["npm", ["--version"]],
  ])
    assert.equal(
      execFileSync(program, args, { encoding: "utf8" }).trim(),
      JSON.parse(readFileSync(join(NPM_ROOT, "package.json"), "utf8")).version,
    );
});

test("npm's tar module passes a packed tarball with a directory entry", async () => {
  await assertNpmEntries(
    afterPackageJson(plain, tarEntry("package/lib/", "", "5")),
  );
});

for (const [description, bytes, message] of [
  [
    "a GNU header that it reads as a second package.json",
    afterPackageJson(plain, gnuPackageJson(plain)),
    /: npm reads package\/package\.json twice$/,
  ],
  [
    "a symbolic link",
    afterPackageJson(
      plain,
      tarEntry("package/link", "", "2", { linkpath: "package.json" }),
    ),
    /: npm reads package\/link as SymbolicLink, which is not a regular file or a directory$/,
  ],
  [
    "an entry outside package/",
    afterPackageJson(plain, tarEntry("other/package.json", "{}")),
    /: npm reads other\/package\.json, which is outside package\/$/,
  ],
  [
    "a damaged checksum",
    (() => {
      const damaged = tarEntry("package/index.cjs.js", "");
      damaged[0] ^= 1;
      return afterPackageJson(plain, damaged);
    })(),
    /: npm (reads a damaged tarball|cannot read the tarball): /,
  ],
])
  test(`npm's tar module refuses ${description}`, async () => {
    await assert.rejects(assertNpmEntries(bytes), message);
  });

test("npm's manifest reader takes the package.json that a GNU header carries", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "glam-sdk-manifest-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const good = join(directory, "good.tgz");
  writeFileSync(good, afterPackageJson(plain));
  await assertNpmManifest(good, plain.pkg, plain.head);
  const gnu = join(directory, "gnu.tgz");
  writeFileSync(gnu, afterPackageJson(plain, gnuPackageJson(plain)));
  await assert.rejects(
    assertNpmManifest(gnu, plain.pkg, plain.head),
    /npm reads a package\.json from the tarball that is not this commit's package\.json with gitHead added/,
  );
});

test("the verify mode installs the published version without scripts, checks its integrity and loads it", (t) => {
  const checkout = taggedCheckout(t);
  const result = mode(
    checkout,
    "verify",
    {
      RELEASE_INTEGRITY: sri(Buffer.from("tarball")),
      STAND_IN_PUBLISHED: "1",
      STAND_IN_PACKAGE: PACKAGE,
    },
    { standIns: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const npm = records(checkout, "npm");
  assert.equal(npm.length, 2, npm.join("\n"));
  assert.match(
    npm[0],
    /^install --ignore-scripts --no-audit --no-fund --prefer-online --registry=https:\/\/registry\.npmjs\.org --cache=\S+ @glamsystems\/glam-sdk@1\.2\.0$/,
  );
  assert.match(npm[1], /^audit signatures /);
  assert.ok(
    !records(checkout, "requests").some((line) =>
      line.includes("api.github.com"),
    ),
  );
});

test("the verify mode refuses an installed tarball other than the reported one", (t) => {
  const checkout = taggedCheckout(t);
  const result = mode(
    checkout,
    "verify",
    {
      RELEASE_INTEGRITY: sri(Buffer.from("tarball")),
      STAND_IN_LOCK_INTEGRITY: sri(Buffer.from("another tarball")),
      STAND_IN_PUBLISHED: "1",
      STAND_IN_PACKAGE: PACKAGE,
    },
    { standIns: true },
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /Installed tarball does not match the verified registry artifact/,
  );
  assert.equal(records(checkout, "npm").length, 1);
});

test("the finish mode checks the registry through fetch, creates the GitHub release and runs no npm", (t) => {
  const checkout = taggedCheckout(t);
  const result = mode(
    checkout,
    "finish",
    {
      RELEASE_INTEGRITY: sri(Buffer.from("tarball")),
      STAND_IN_PUBLISHED: "1",
      STAND_IN_LATEST: release.version,
      STAND_IN_GITHUB: "allow",
      GH_TOKEN: "test-token",
    },
    { standIns: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(records(checkout, "npm"), []);
  const requests = records(checkout, "requests");
  assert.ok(
    requests.includes(`POST api.github.com/repos/${REPOSITORY}/releases`),
    requests.join("\n"),
  );
  assert.ok(
    requests.includes(
      "GET registry.npmjs.org/%40glamsystems%2Fglam-sdk/latest",
    ),
    requests.join("\n"),
  );
});

test("the finish mode refuses an npm latest behind the release before any GitHub request", (t) => {
  const checkout = taggedCheckout(t);
  const result = mode(
    checkout,
    "finish",
    {
      RELEASE_INTEGRITY: sri(Buffer.from("tarball")),
      STAND_IN_PUBLISHED: "1",
      STAND_IN_GITHUB: "allow",
      GH_TOKEN: "test-token",
    },
    { standIns: true },
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /npm latest is missing or behind this release/);
  assert.ok(
    !records(checkout, "requests").some((line) =>
      line.includes("api.github.com"),
    ),
  );
});
