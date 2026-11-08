// Checks that the packed package behaves, not only that it loads.
//
//   node scripts/check-bundle.mjs [tarball]
//
// Run it from the package root after the build. Without an argument it packs
// the package itself; the publisher passes the tarball it is about to publish.
// The tarball is unpacked as a dependency of a scratch consumer under .build,
// so its own dependencies resolve from the root's node_modules. Both entries
// are loaded: the CommonJS one with require(), the ES module one by importing
// index.esm.js, because the package has no exports map and no "type" field.
//
// Each entry must build a StateModel that keeps every field its parent class
// assigns. A build that applies define semantics to class fields resets the
// fields a subclass declares again, and the entry still loads and still
// exports every name.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

// One value for every field the StateIdlModel constructor assigns.
function stateFields(StateAccountType) {
  return {
    accountType: StateAccountType.VAULT,
    name: [1, 2, 3],
    uri: "https://example.invalid/state",
    enabled: true,
    oracleConfigs: { field: "oracleConfigs" },
    assets: [{ field: "assets" }],
    created: { field: "created" },
    owner: { field: "owner" },
    portfolioManagerName: [4, 5],
    borrowable: [{ field: "borrowable" }],
    timelockDuration: 77,
    integrationAcls: [{ field: "integrationAcls" }],
    delegateAcls: [{ field: "delegateAcls" }],
  };
}

// What is wrong with one loaded entry, as sentences; none when it behaves.
function findings({ StateModel, StateAccountType }) {
  if (
    typeof StateModel !== "function" ||
    typeof StateAccountType?.equals !== "function" ||
    !StateAccountType.VAULT
  )
    return ["StateModel or StateAccountType is not exported"];
  const fields = stateFields(StateAccountType);
  const model = new StateModel(fields);
  const found = [];
  const lost = Object.keys(fields).filter(
    (field) => !isDeepStrictEqual(model[field], fields[field]),
  );
  if (lost.length > 0) found.push(`StateModel lost ${lost.join(", ")}`);
  const comparison =
    "StateAccountType.equals(model.accountType, StateAccountType.VAULT)";
  try {
    const equal = StateAccountType.equals(
      model.accountType,
      StateAccountType.VAULT,
    );
    if (equal !== true) found.push(`${comparison} returned ${equal}`);
  } catch (error) {
    found.push(`${comparison} threw: ${error?.message ?? error}`);
  }
  return found;
}

function pack(root, destination) {
  const [{ filename }] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        `--pack-destination=${destination}`,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  return join(destination, filename);
}

// Unpacks the tarball where a consumer's install would put the package.
function unpack(tarball, consumer) {
  const staging = join(consumer, "package");
  mkdirSync(staging);
  execFileSync(
    "tar",
    ["-xzf", tarball, "-C", staging, "--strip-components=1"],
    { stdio: "inherit" },
  );
  const { name } = JSON.parse(
    readFileSync(join(staging, "package.json"), "utf8"),
  );
  const directory = join(consumer, "node_modules", name);
  mkdirSync(dirname(directory), { recursive: true });
  renameSync(staging, directory);
  return { name, directory };
}

const root = process.cwd();
mkdirSync(join(root, ".build"), { recursive: true });
const consumer = mkdtempSync(join(root, ".build", "bundle-check-"));
let tarball;
let failed = false;
try {
  tarball = process.argv[2] ? resolve(process.argv[2]) : pack(root, consumer);
  const { name, directory } = unpack(tarball, consumer);
  const require = createRequire(join(consumer, "consumer.cjs"));
  const entries = {
    [`require("${name}")`]: () => require(name),
    [`import("${name}/index.esm.js")`]: () =>
      import(pathToFileURL(join(directory, "index.esm.js")).href),
  };
  for (const [entry, load] of Object.entries(entries)) {
    let found;
    try {
      found = findings(await load());
    } catch (error) {
      found = [`could not be checked: ${error?.stack ?? error}`];
    }
    for (const finding of found) console.error(`${entry}: ${finding}`);
    if (found.length === 0)
      console.log(`${entry}: StateModel keeps every field its parent assigns`);
    else failed = true;
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
if (failed)
  console.error(
    `${basename(tarball)} fails the bundle check. Correct the source or the build, then run the check again.`,
  );
// An entry that leaves a handle open must not keep the check running.
process.exit(failed ? 1 : 0);
