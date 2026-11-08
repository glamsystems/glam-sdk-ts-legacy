import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

export const PACKAGE = "@glamsystems/glam-sdk";
export const REPOSITORY = "glamsystems/glam-sdk-ts-legacy";
const REGISTRY = "https://registry.npmjs.org";
const BUNDLE_CHECK = fileURLToPath(
  new URL("./check-bundle.mjs", import.meta.url),
);
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
// The publishConfig the mirror's package.json has always carried. The publish
// flags set access too, so npm ignores it.
const PUBLISH_CONFIG = { access: "public" };
// The files npm pack must put in the release tarball.
const EXPECTED_FILES = [
  "index.cjs.js",
  "index.esm.js",
  "index.cjs.d.ts",
  "index.esm.d.ts",
  "target/idl/glam_protocol.json",
  "target/types/glam_protocol.ts",
];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function validateRelease({
  marker,
  pkg,
  lock,
  ref,
  commit,
  repository,
}) {
  assert.equal(repository, REPOSITORY, "Unexpected publishing repository");
  assert.match(commit, SHA, "Release commit must be a full Git SHA");
  assert.equal(marker.schemaVersion, 1, "Unknown release metadata schema");
  assert.equal(marker.package, PACKAGE, "Unexpected release package");
  assert.match(
    marker.version,
    VERSION,
    "Only stable SDK versions are supported",
  );
  assert.equal(marker.source?.repository, "glamsystems/glam");
  assert.match(marker.source?.commit, SHA, "Missing monorepo release commit");
  assert.equal(typeof marker.notes, "string", "Release notes must be text");
  assert.ok(marker.notes.trim(), "Release notes must not be empty");
  assert.equal(ref, `refs/tags/v${marker.version}`, "Run on the release tag");
  assert.equal(pkg.name, PACKAGE);
  assert.equal(
    pkg.version,
    marker.version,
    "Package and release versions differ",
  );
  assert.equal(lock.name, PACKAGE);
  assert.equal(lock.version, marker.version, "Lockfile version differs");
  assert.equal(lock.packages?.[""]?.name, PACKAGE);
  assert.equal(lock.packages?.[""]?.version, marker.version);
  assert.equal(
    pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, ""),
    `https://github.com/${REPOSITORY}`,
    "Package repository must match trusted publishing",
  );
  // The pack mode writes gitHead, so the committed package.json has none.
  assert.equal(pkg.gitHead, undefined, "package.json must not carry gitHead");
  // npm applies every publishConfig key that is not also a command line flag.
  assert.ok(
    pkg.publishConfig === undefined ||
      isDeepStrictEqual(pkg.publishConfig, PUBLISH_CONFIG),
    "package.json may carry no publishConfig other than access public",
  );
  return { ...marker, commit, tag: `v${marker.version}` };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function registryVersion(version, fetcher = fetch) {
  const response = await fetcher(
    `${REGISTRY}/${encodeURIComponent(PACKAGE)}/${encodeURIComponent(version)}`,
    {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `Registry lookup failed: HTTP ${response.status}`,
    );
  }
  return response.json();
}

export function assertPackageIdentity(metadata, release, integrity) {
  assert.equal(metadata.name, PACKAGE, "Registry package name differs");
  assert.equal(metadata.version, release.version, "Registry version differs");
  assert.equal(
    metadata.gitHead,
    release.commit,
    "Registry source commit differs",
  );
  assert.equal(metadata.dist?.integrity, integrity, "Registry tarball differs");
  assert.equal(
    metadata.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, ""),
    `https://github.com/${REPOSITORY}`,
    "Registry source repository differs",
  );
}

export function compareVersions(left, right) {
  assert.match(left, VERSION, "npm latest must be a stable version");
  assert.match(right, VERSION);
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

export async function waitForPackage({
  release,
  integrity,
  lookup,
  delay = sleep,
  attempts = 20,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let metadata;
    try {
      metadata = await lookup(release.version);
    } catch (error) {
      // Authentication and other client errors require intervention, not retries.
      if (error.status && error.status < 500 && error.status !== 429)
        throw error;
      lastError = error;
    }
    if (metadata) {
      // A conflicting immutable version must never be accepted or overwritten.
      assertPackageIdentity(metadata, release, integrity);
      return metadata;
    }
    if (attempt < attempts) await delay(15_000);
  }
  throw new Error("Published SDK did not become visible on npm", {
    cause: lastError,
  });
}

// npm records these on the registry and requires both for this package.
export function assertSignedAndAttested(metadata) {
  assert.ok(metadata.dist?.signatures?.length, "Registry signature is missing");
  assert.equal(
    metadata.dist?.attestations?.provenance?.predicateType,
    "https://slsa.dev/provenance/v1",
    "SDK provenance is missing",
  );
}

// The publish job. It publishes only after a registry 404 and never twice.
export async function publishRelease({
  release,
  integrity,
  lookup = registryVersion,
  latest = () => registryVersion("latest"),
  publish,
  delay = sleep,
  attempts = 20,
}) {
  // Only a real registry 404 permits publication. A failed lookup does not.
  const existing = await lookup(release.version);
  if (existing) {
    assertPackageIdentity(existing, release, integrity);
    console.log(
      `${PACKAGE}@${release.version} already matches this release and is not published again`,
    );
  } else {
    const currentLatest = await latest();
    assert.ok(
      !currentLatest ||
        compareVersions(currentLatest.version, release.version) < 0,
      "Refusing to publish an older version over npm latest",
    );
    try {
      await publish();
    } catch (error) {
      // A lost publish response can follow a successful registry write. Resolve
      // that uncertainty by verifying identity, never by publishing a second time.
      console.warn(
        `Publish command failed; checking registry: ${error.message}`,
      );
    }
  }
  const metadata = await waitForPackage({
    release,
    integrity,
    lookup,
    delay,
    attempts,
  });
  assertSignedAndAttested(metadata);
  return metadata;
}

// The verify job: the registry identity, then the installation check.
export async function verifyRelease({
  release,
  integrity,
  lookup = registryVersion,
  verify,
  delay = sleep,
  attempts = 20,
}) {
  const metadata = await waitForPackage({
    release,
    integrity,
    lookup,
    delay,
    attempts,
  });
  await verify(metadata);
}

// The finish job: the registry identity and npm latest, then the GitHub Release.
export async function finishRelease({
  release,
  integrity,
  lookup = registryVersion,
  latest = () => registryVersion("latest"),
  finalize,
  delay = sleep,
  attempts = 20,
}) {
  const metadata = await waitForPackage({
    release,
    integrity,
    lookup,
    delay,
    attempts,
  });
  assertSignedAndAttested(metadata);
  const currentLatest = await latest();
  assert.ok(
    currentLatest &&
      compareVersions(currentLatest.version, release.version) >= 0,
    "npm latest is missing or behind this release; finish dist-tag recovery before retrying",
  );
  console.log(`Verified npm latest: ${currentLatest.version}`);
  await finalize(metadata);
}

export function releaseBody(release) {
  return `${release.notes.trim()}\n\n<!-- sdk-release: ${release.source.commit} ${release.commit} -->\n`;
}

export async function ensureGitHubRelease(release, request) {
  const prefix = `/repos/${REPOSITORY}`;
  let object = (await request(`${prefix}/git/ref/tags/${release.tag}`)).object;
  for (let count = 0; object.type === "tag" && count < 5; count++) {
    object = (await request(`${prefix}/git/tags/${object.sha}`)).object;
  }
  assert.equal(object.type, "commit", "Release tag must resolve to a commit");
  assert.equal(
    object.sha,
    release.commit,
    "Public tag moved to another commit",
  );
  const body = releaseBody(release);
  const existing = await request(`${prefix}/releases/tags/${release.tag}`, {
    allow404: true,
  });
  if (existing) {
    assert.equal(existing.tag_name, release.tag);
    assert.equal(existing.target_commitish, release.commit);
    assert.equal(
      existing.body?.trim(),
      body.trim(),
      "Existing release differs",
    );
    assert.equal(existing.prerelease, false);
    assert.equal(existing.draft, false, "Existing release is still a draft");
    console.log(`GitHub release already complete: ${existing.html_url}`);
    return existing;
  }
  return request(`${prefix}/releases`, {
    method: "POST",
    body: {
      tag_name: release.tag,
      target_commitish: release.commit,
      name: release.tag,
      body,
      draft: false,
      prerelease: false,
      // Backfilling an older release must not move GitHub's latest pointer back.
      make_latest: "legacy",
    },
  });
}

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  })?.trim();
}

async function loadRelease() {
  const [marker, pkg, lock] = await Promise.all(
    [".sdk-release.json", "package.json", "package-lock.json"].map(
      async (file) => JSON.parse(await readFile(file, "utf8")),
    ),
  );
  const release = validateRelease({
    marker,
    pkg,
    lock,
    ref: process.env.GITHUB_REF,
    commit: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
  });
  assert.equal(command("git", ["rev-parse", "HEAD"]), release.commit);
  assert.equal(
    command("git", ["rev-parse", `refs/tags/${release.tag}^{commit}`]),
    release.commit,
  );
  console.log(`Validated ${release.tag} at ${release.commit}`);
  return release;
}

async function githubRequest(path, { method = "GET", body, allow404 } = {}) {
  assert.ok(process.env.GH_TOKEN, "GH_TOKEN is required to finish the release");
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok)
    throw new HttpError(
      response.status,
      `GitHub request failed: ${response.status}`,
    );
  return response.json();
}

export async function verifyInstallation(release, metadata) {
  const directory = await mkdtemp(join(tmpdir(), "glam-sdk-verify-"));
  await writeFile(join(directory, "package.json"), '{"private":true}\n');
  let cache;
  for (let attempt = 1; attempt <= 20; attempt++) {
    cache = join(directory, `cache-${attempt}`);
    // Fresh cache prevents a stale packument from repeating ETARGET after publish.
    try {
      command(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--prefer-online",
          `--registry=${REGISTRY}`,
          `--cache=${cache}`,
          `${PACKAGE}@${release.version}`,
        ],
        { cwd: directory, stdio: "inherit" },
      );
      break;
    } catch (error) {
      if (attempt === 20) throw error;
      await sleep(15_000);
    }
  }
  const installedLock = JSON.parse(
    await readFile(join(directory, "package-lock.json"), "utf8"),
  );
  assert.equal(
    installedLock.packages?.[`node_modules/${PACKAGE}`]?.integrity,
    metadata.dist.integrity,
    "Installed tarball does not match the verified registry artifact",
  );
  command(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    assert.equal(require('${PACKAGE}/package.json').version, process.argv[1]);
    assert.equal(typeof require('${PACKAGE}').getGlamProtocolProgramId, 'function');
  `,
      release.version,
    ],
    { cwd: directory, stdio: "inherit" },
  );
  command(
    "npm",
    [
      "audit",
      "signatures",
      "--prefer-online",
      `--cache=${cache}`,
      `--registry=${REGISTRY}`,
    ],
    {
      cwd: directory,
      stdio: "inherit",
    },
  );
}

export const tarballName = (version) => `glamsystems-glam-sdk-${version}.tgz`;

export const sri = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// The regular files of a gzipped tarball by path. This reader is a stricter
// first layer: it refuses every header and record npm pack does not write.
// npm's own listing and manifest reader below are the authority.
export function tarballFiles(gzipped) {
  const tar = gunzipSync(gzipped);
  const files = new Map();
  let pax = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) continue;
    const text = (start, length) => {
      const field = header.subarray(start, start + length);
      const end = field.indexOf(0);
      return field.subarray(0, end === -1 ? length : end).toString("utf8");
    };
    const octal = (start, length) => {
      const digits = text(start, length).trim();
      assert.match(digits, /^[0-7]+$/, "The tarball has a malformed header");
      return Number.parseInt(digits, 8);
    };
    let sum = 0;
    for (let index = 0; index < 512; index++)
      sum += index >= 148 && index < 156 ? 32 : header[index];
    assert.equal(octal(148, 8), sum, "The tarball has a damaged header");
    // npm's tar module reads the prefix field only in this POSIX form.
    assert.equal(
      header.subarray(257, 263).toString("latin1"),
      "ustar\0",
      "The tarball has a header that is not POSIX ustar",
    );
    assert.equal(
      header.subarray(263, 265).toString("latin1"),
      "00",
      "The tarball has a ustar header whose version is not 00",
    );
    // npm's tar module reads a prefix of 155 bytes when byte 475 is not 0, and
    // of 130 bytes otherwise. npm pack writes zeros after the prefix.
    const field = header.subarray(345, header[475] === 0 ? 475 : 500);
    const prefixEnd = field.indexOf(0) === -1 ? field.length : field.indexOf(0);
    assert.ok(
      header.subarray(345 + prefixEnd).every((byte) => byte === 0),
      "The tarball has a ustar header with bytes after its prefix that npm pack does not write",
    );
    const type = String.fromCharCode(header[156]);
    const size = pax?.size ?? octal(124, 12);
    // npm's tar module puts the prefix field before a pax path as well.
    const prefix = field.subarray(0, prefixEnd).toString("utf8");
    const name = pax?.path ?? text(0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    const body = tar.subarray(offset, offset + size);
    assert.equal(body.length, size, "The tarball ends inside an entry");
    offset += Math.ceil(size / 512) * 512;
    if (type === "x") {
      assert.equal(pax, null, "The tarball has two extended headers in a row");
      pax = paxRecords(body);
      continue;
    }
    pax = null;
    assert.ok(
      type === "0" || type === "\0",
      `The tarball holds ${path}, which is not a regular file`,
    );
    const parts = path.split("/");
    assert.ok(
      parts.length > 1 &&
        parts[0] === "package" &&
        parts.every((part) => part && part !== "." && part !== ".."),
      `The tarball holds ${path}, which is outside package/`,
    );
    assert.ok(!files.has(path), `The tarball holds ${path} twice`);
    files.set(path, body);
  }
  assert.equal(pax, null, "The tarball ends with an extended header");
  return files;
}

// The path and size records of a pax extended header, whose lengths count
// bytes. npm's tar module drops a record whose length is not its decimal
// byte count, so this reader refuses one.
function paxRecords(body) {
  const records = {};
  for (let rest = body; rest.length > 0; ) {
    const space = rest.indexOf(0x20);
    const digits = rest.subarray(0, Math.max(space, 0)).toString("latin1");
    const length = /^[1-9][0-9]*$/.test(digits) ? Number(digits) : 0;
    const record = rest.subarray(space + 1, length);
    const equals = record.indexOf(0x3d);
    assert.ok(
      space > 0 &&
        length > space &&
        length <= rest.length &&
        equals > 0 &&
        rest[length - 1] === 0x0a &&
        rest.subarray(0, length - 1).indexOf(0x0a) === -1 &&
        Buffer.from(record.toString("utf8")).equals(record),
      "The tarball has a malformed extended header",
    );
    const key = record.subarray(0, equals).toString("utf8");
    const value = record
      .subarray(equals + 1, record.length - 1)
      .toString("utf8");
    // npm's tar module splits records at a newline and ends a value at a NUL.
    assert.ok(
      !/[\n\0]/.test(value),
      "The tarball has a malformed extended header",
    );
    if (key === "path") records.path = value;
    if (key === "size") {
      assert.match(
        value,
        /^\d+$/,
        "The tarball has a malformed extended header",
      );
      records.size = Number(value);
    }
    rest = rest.subarray(length);
  }
  return records;
}

// The package.json this reader finds must be this commit's with gitHead added.
export function assertTarballManifest(files, pkg, commit) {
  const packed = files.get("package/package.json");
  assert.ok(packed, "The tarball has no package/package.json");
  assert.ok(
    isDeepStrictEqual(JSON.parse(packed.toString("utf8")), {
      ...pkg,
      gitHead: commit,
    }),
    "The tarball's package.json is not this commit's package.json with gitHead added",
  );
}

// The npm that publishes. No job installs npm, so it is the one bundled with
// this Node, and the checks below load npm's own modules from it.
export const NPM_ROOT = resolve(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "npm",
);
const fromNpm = (name) => createRequire(join(NPM_ROOT, "package.json"))(name);
// Pack and publish run this npm as this Node, so they are the npm checked here.
export const NPM_CLI = join(NPM_ROOT, "bin", "npm-cli.js");

// The entries as npm's tar module lists them. Each is a regular file or a
// directory under package/, listed once, and the module warns of nothing.
export async function assertNpmEntries(gzipped) {
  const refusals = [];
  const seen = new Set();
  const parser = fromNpm("tar").t({
    strict: true,
    onwarn: (code, message) =>
      refusals.push(`npm reads a damaged tarball: ${code} ${message}`),
    onentry: (entry) => {
      const directory = entry.type === "Directory";
      const path = directory ? entry.path.replace(/\/$/, "") : entry.path;
      const parts = path.split("/");
      if (!directory && entry.type !== "File" && entry.type !== "OldFile")
        refusals.push(
          `npm reads ${path} as ${entry.type}, which is not a regular file or a directory`,
        );
      else if (
        !(
          parts.length > 1 &&
          parts[0] === "package" &&
          parts.every((part) => part && part !== "." && part !== "..")
        )
      )
        refusals.push(`npm reads ${path}, which is outside package/`);
      else if (seen.has(path)) refusals.push(`npm reads ${path} twice`);
      seen.add(path);
    },
  });
  await new Promise((done) => {
    parser.on("error", (error) => {
      refusals.push(`npm cannot read the tarball: ${error.message}`);
      done();
    });
    parser.on("end", done);
    parser.end(gzipped);
  });
  if (refusals.length) throw new Error(refusals.join("\n"));
}

// What npm sends of a manifest, without the readme and pacote's own records of
// the file. JSON drops the symbols that npm's reader adds.
const comparable = (manifest) => {
  const { readme, readmeFilename, _integrity, _resolved, _from, ...rest } =
    JSON.parse(JSON.stringify(manifest));
  return rest;
};

// The manifest npm publish reads, with the call publish.js makes, against this
// commit's package.json with gitHead added, both normalized by npm.
export async function assertNpmManifest(tarball, pkg, commit) {
  const scratch = await mkdtemp(join(tmpdir(), "glam-sdk-manifest-"));
  try {
    const read = await fromNpm("pacote").manifest(`file:${tarball}`, {
      fullMetadata: true,
      fullReadJson: true,
      cache: join(scratch, "cache"),
    });
    // A directory with the package.json alone, so no other file adds a field.
    const alone = join(scratch, "expected");
    await mkdir(alone);
    await writeFile(
      join(alone, "package.json"),
      JSON.stringify({ ...pkg, gitHead: commit }),
    );
    const expected = await fromNpm("@npmcli/package-json").prepare(alone);
    assert.ok(
      isDeepStrictEqual(comparable(read), comparable(expected.content)),
      "npm reads a package.json from the tarball that is not this commit's package.json with gitHead added",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// This reader first, then npm's own tar module and manifest reader.
export async function assertPublishable(tarball, bytes, pkg, commit) {
  assertTarballManifest(tarballFiles(bytes), pkg, commit);
  await assertNpmEntries(bytes);
  await assertNpmManifest(tarball, pkg, commit);
}

// The tarball the build job packed, checked against what that job reported
// and against this checkout. It is read here and never unpacked.
async function checkedTarball(release) {
  const integrity = reportedIntegrity();
  assert.ok(process.env.RELEASE_TARBALL, "RELEASE_TARBALL is required");
  const tarball = resolve(process.env.RELEASE_TARBALL);
  // Real paths, so a symbolic link in either path cannot hide the checkout.
  const inside = relative(
    await realpath(process.cwd()),
    await realpath(tarball),
  );
  assert.equal(
    basename(tarball),
    tarballName(release.version),
    "RELEASE_TARBALL does not name this release's tarball",
  );
  assert.ok(
    inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside),
    "RELEASE_TARBALL must be outside the checkout",
  );
  const bytes = await readFile(tarball);
  assert.equal(
    sri(bytes),
    integrity,
    "The tarball differs from the one the build job reported",
  );
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  await assertPublishable(tarball, bytes, pkg, release.commit);
  return { tarball, integrity };
}

function reportedIntegrity() {
  const integrity = process.env.RELEASE_INTEGRITY ?? "";
  assert.match(
    integrity,
    INTEGRITY,
    "RELEASE_INTEGRITY is not a sha512 integrity",
  );
  return integrity;
}

// Loads both entries of the packed tarball and refuses one that misbehaves.
// The child's environment carries only PATH.
function checkBundle(tarball) {
  try {
    command(process.execPath, [BUNDLE_CHECK, tarball], {
      env: { PATH: process.env.PATH },
      stdio: "inherit",
    });
  } catch (error) {
    throw new Error(
      `${tarball} failed the bundle check. This run published nothing.`,
      { cause: error },
    );
  }
}

// The build job. npm reads gitHead from the folder's git HEAD when it publishes
// a directory, and from package.json when it publishes a tarball.
async function pack(release) {
  const destination = process.env.RELEASE_PACK_DIR ?? "";
  assert.ok(
    isAbsolute(destination),
    "RELEASE_PACK_DIR must be an absolute path",
  );
  assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  await mkdir(destination, { recursive: true });
  const original = await readFile("package.json", "utf8");
  const pkg = JSON.parse(original);
  let packed;
  try {
    await writeFile(
      "package.json",
      `${JSON.stringify({ ...pkg, gitHead: release.commit }, null, 2)}\n`,
    );
    packed = JSON.parse(
      command(process.execPath, [
        NPM_CLI,
        "pack",
        "--ignore-scripts",
        "--json",
        `--pack-destination=${destination}`,
      ]),
    )[0];
  } finally {
    await writeFile("package.json", original);
  }
  const files = new Set(packed.files.map((file) => file.path));
  for (const file of EXPECTED_FILES)
    assert.ok(files.has(file), `Missing expected package file: ${file}`);
  assert.equal(packed.name, PACKAGE);
  assert.equal(packed.version, release.version);
  assert.equal(packed.filename, tarballName(release.version));
  const tarball = join(destination, packed.filename);
  const bytes = await readFile(tarball);
  const integrity = sri(bytes);
  assert.equal(packed.integrity, integrity);
  await assertPublishable(tarball, bytes, pkg, release.commit);
  await writeFile(
    join(destination, "release-pack.json"),
    `${JSON.stringify(packed, null, 2)}\n`,
  );
  checkBundle(tarball);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `tarball=${packed.filename}\nintegrity=${integrity}\n`,
  );
  console.log(`Packed ${packed.filename} ${integrity}`);
}

// npm publish of a tarball runs no lifecycle script. npm drops each
// publishConfig key that is also a flag here. For a scoped package npm prefers
// the scope's registry over --registry, so both are flags.
export const publishArgs = (tarball) => [
  "publish",
  tarball,
  "--ignore-scripts",
  "--access",
  "public",
  "--provenance",
  "--tag",
  "latest",
  `--registry=${REGISTRY}`,
  `--@glamsystems:registry=${REGISTRY}/`,
];

async function main() {
  const mode = process.argv[2];
  assert.ok(
    ["validate", "pack", "publish", "verify", "finish"].includes(mode),
    "Use validate, pack, publish, verify or finish",
  );
  const release = await loadRelease();
  if (mode === "validate") return;
  if (mode === "pack") return pack(release);
  if (mode === "publish") {
    const { tarball, integrity } = await checkedTarball(release);
    // An empty directory, so npm finds no package files or .npmrc beside it.
    const empty = await mkdtemp(join(tmpdir(), "glam-sdk-publish-"));
    await publishRelease({
      release,
      integrity,
      publish: () =>
        command(process.execPath, [NPM_CLI, ...publishArgs(tarball)], {
          cwd: empty,
          stdio: "inherit",
        }),
    });
    return;
  }
  const integrity = reportedIntegrity();
  if (mode === "verify")
    return verifyRelease({
      release,
      integrity,
      verify: (metadata) => verifyInstallation(release, metadata),
    });
  return finishRelease({
    release,
    integrity,
    finalize: () => ensureGitHubRelease(release, githubRequest),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
