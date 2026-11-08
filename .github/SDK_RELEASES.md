# SDK publication

The private `glamsystems/glam` monorepo prepares and approves SDK releases.
This repository builds the public source and publishes `@glamsystems/glam-sdk`
using npm trusted publishing. No developer npm token is needed.

## Installation and activation

This document, the build and publishing workflows, `scripts/release-sdk.mjs`,
`scripts/check-bundle.mjs` and their test belong to the monorepo, under
`scripts/sdk-release/public/glam-sdk-ts-legacy/`. The source sync installs
them here with the monorepo's root `.node-version` and lists them in
`.github/release-companion.json`. Change them in
the monorepo, not here. Their action pins follow the monorepo's Dependabot
updates.

Keep the npm trusted publisher configured for:

- Organization: `glamsystems`
- Repository: `glam-sdk-ts-legacy`
- Workflow: `publish.yml`
- Environment: `npm-production`
- Permission to publish directly with `npm publish`

Set the repository variable `SDK_RELEASE_PUBLISH_ENABLED=true` only when the
monorepo coordinator and credentials are configured and activation is approved.
Without that variable, both tag pushes and manual runs skip publication.
Do not rename the workflow or move publishing into a workflow called from the
private repository. npm validates the publishing workflow identity.

## Release contract

The coordinator creates `release/sdk-vX.Y.Z` from public `main`, copies the exact
approved SDK source, updates the runtime package fields and npm lockfile, and
adds `.sdk-release.json`:

```json
{
  "schemaVersion": 1,
  "package": "@glamsystems/glam-sdk",
  "version": "1.2.0",
  "source": {
    "repository": "glamsystems/glam",
    "commit": "0123456789012345678901234567890123456789"
  },
  "notes": "Approved release notes"
}
```

It tags that exact commit `vX.Y.Z`. The tag, metadata, package and both lockfile
version fields must agree. The release commit can be on its isolated release
branch. It does not have to be an ancestor of public `main`. Only stable versions
are supported. Regular source-sync commits and manual runs on `main` cannot
publish through this workflow.

## Jobs

`publish.yml` runs four jobs at the tag's exact SHA. Each checks out that SHA
without persisted credentials, sets up the Node version in `.node-version`
without a package cache and validates the release identity. `.node-version`
holds the monorepo controller's exact Node version: the controller writes its
own root `.node-version` into every release snapshot. No job installs
another npm, so every job runs the npm bundled with that Node. The release
script runs `npm pack` and `npm publish` as that Node with the bundled npm's
`bin/npm-cli.js`, the npm whose modules its checks load. Only the build job
runs the package's dependencies, and it holds no write permission.

| Job       | Name               | Permissions                                                       | What it runs                                                            |
| --------- | ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `build`   | Build SDK          | `contents: read`                                                  | `npm ci --ignore-scripts`, `npm run build`, then `release-sdk.mjs pack` |
| `publish` | Publish SDK        | `contents: read`, `id-token: write`, environment `npm-production` | `release-sdk.mjs publish`                                               |
| `verify`  | Verify SDK         | `contents: read`                                                  | `release-sdk.mjs verify`                                                |
| `finish`  | Finish SDK release | `contents: write`                                                 | `release-sdk.mjs finish`                                                |

`publish` needs `build`, `verify` needs `build` and `publish`, and `finish`
needs `build` and `verify`. Every job carries the publication condition. The
private controller reads the run's conclusion and the jobs named **Publish
SDK** and **Finish SDK release**, so a completed run means every job passed.
**Finish SDK release** must have passed in the run's latest attempt, and
**Publish SDK** in that attempt or an earlier one, because **Re-run failed
jobs** leaves a publish job that passed at its earlier attempt.

The pack mode writes the release commit into `package.json` as `gitHead`, packs
with `--ignore-scripts` and restores the committed `package.json`. npm reads
`gitHead` from the folder's git HEAD when it publishes a directory. When it
publishes a tarball it reads `package.json` in a temporary folder under its
cache, so the tarball carries `gitHead` itself. The pack mode then checks the
expected files and the tarball's integrity, and `scripts/check-bundle.mjs`
unpacks the tarball and loads both entries, `index.cjs.js` with `require` and
`index.esm.js` with `import`. Each entry must build a `StateModel` that keeps
every field its parent class assigns. A tarball that fails the check is not
reported. The build job then writes the tarball's file name and its `sha512`
integrity to its outputs. It uploads the tarball and the pack manifest as the
artifact `release-tarball-<run attempt>`. The build workflow runs the same
bundle check on pushes to `main`, pull requests and manual runs.

The publish job holds the `id-token: write` permission and a read-only
workflow token. It installs nothing from the registry: it runs no `npm ci`, no
build and no install of npm or of the package. It downloads the artifact
outside the checkout and checks the tarball before its first registry request,
in this order:

1. The tarball's `sha512` equals the integrity the build job reported.
2. The script's own tar reader is a stricter first layer, and npm's listing
   and manifest below are the authority. It accepts only POSIX ustar headers
   with version `00` and with nothing after the prefix field that `npm pack`
   does not write. It reads the prefix field as npm's tar module does, 155
   bytes when byte 475 is not 0 and 130 bytes otherwise. It refuses a pax
   record that holds a newline or a NUL, and one whose length is not plain
   decimal digits equal to the record's byte count, such as `1e2` or `0x64`.
   It refuses a second entry under one path, an entry outside `package/` and
   any entry that is not a regular file. Its `package/package.json` must
   equal this commit's `package.json` with `gitHead` added.
3. The `tar` module of the npm bundled with the job's Node lists the tarball.
   It must warn of nothing, and each entry must be a regular file or a
   directory under `package/`, listed once.
4. The `pacote` module of that npm reads the manifest with the call
   `npm publish` makes for a tarball, `pacote.manifest` with `fullMetadata`
   and `fullReadJson`. Normalized by npm, it must equal this commit's
   `package.json` with `gitHead` added, read alone in an empty directory. Only
   the readme and pacote's own records of the file may differ. A field the
   build job added, such as `publishConfig`, fails, and so does a file that
   makes npm add a field, such as a `binding.gyp`.

The pack mode runs the same checks on the tarball it packed. Every mode also
refuses a `package.json` that carries a `publishConfig` other than
`{ "access": "public" }`, which the mirror has always carried. The job then
publishes from an empty directory:

```bash
npm publish <tarball> --ignore-scripts --access public --provenance --tag latest --registry=https://registry.npmjs.org --@glamsystems:registry=https://registry.npmjs.org/
```

npm runs no lifecycle script for a tarball and still exchanges the job's OIDC
token for a publishing token. npm drops each `publishConfig` key that is also
one of these flags and applies the others. For a scoped package npm prefers
the scope's registry over `--registry`, and the token exchange goes to that
registry, so the command sets both.

The publish job treats only a registry HTTP 404 as absence. It publishes a
missing version once, then waits until the registry shows that exact version
with a signature and SLSA provenance. A failed publish command is settled by
that identity check, never by a second publish. An existing version is
accepted only when its name, version, source repository, `gitHead` and tarball
integrity match. An older missing version is never published over npm
`latest`.

The verify job installs the published version with `--ignore-scripts` into a
temporary directory with fresh caches and retries. It requires the installed
tarball's integrity to equal the reported one, loads the package with
`require`, and runs `npm audit signatures`. The finish job runs no npm. It
checks the registry identity, signature and provenance through `fetch` and
requires npm `latest` to be this version or newer. It then creates the public
GitHub Release with the job's token. Its notes are the approved notes followed
by the identity comment:

```text
<!-- sdk-release: PRIVATE_COMMIT_SHA PUBLIC_COMMIT_SHA -->
```

### What the split leaves open

The build job's dependencies can change the files they build, so the tarball
holds whatever the build produced. The bundle check, the verify job and the
registry checks judge that tarball, and the publish job never runs it. The
build job also holds its Actions runtime token, so its dependencies can write
artifacts and caches of the run. No job in this workflow restores a cache, and
the publish job accepts only the bytes whose digest the build job reported.
They cannot obtain the npm publishing identity, which only the publish job can
request, or write to this repository, which only the finish job can.

Existing tags or releases with conflicting identity cause failure. They are
never moved or overwritten. New releases use GitHub's semantic-version latest
selection. Publishing an older missing npm version cannot regress `latest`.
Recovery of an existing version preserves a newer `latest`. A missing or older
`latest` blocks completion until a maintainer restores the intended dist-tag.

## Recovery and local checks

Do not move the tag or bump the version to retry a run.

- A failed verify or finish job can be rerun alone with **Re-run failed jobs**.
  Each reads only the build job's reported integrity and the registry, so it
  rebuilds nothing.
- **Re-run failed jobs** after a failed build job runs the build job again,
  with every job that needs it, in the new attempt.
- A failed publish job cannot be rerun alone. The artifact name carries the
  run attempt, so a publish job that reruns alone fails at the artifact
  download. Use **Re-run all jobs**, or dispatch `publish.yml` at the
  same `vX.Y.Z` tag.

A rerun of all jobs builds and packs again. When the version is already on
npm, the publish job accepts it only when the rebuilt tarball has the
published digest, and never publishes it again. The tag freezes the source and
the lockfile, and `.node-version` pins the exact Node and its npm. The pin
makes a byte identical rebuild possible. A rebuild that differs cannot
complete at this tag. The published version then stays as it is on npm. Find
what changed the build, then approve a new patch version in the monorepo and
release that. A failed bundle check also fails on every rerun at the tag,
because the tag freezes the source, the build and the lockfile.

The old `v1.1.2` tag predates this contract and has no release metadata. Do not
rewrite historical tags to adopt it. Any historical repair is a separate task.
The private coordinator completes its own tags and release records only after
this public run and registry identity are verified.

Local release logic tests, with the Node version in `.node-version`. The tests
load npm's own modules from the npm bundled with that Node:

```bash
node --test scripts/tests/release-sdk.test.mjs
npm ci --ignore-scripts
npm run build
node scripts/check-bundle.mjs
npm pack --ignore-scripts --dry-run --json
```

The tests inject registry, publication and GitHub operations and never publish.
The bundle check tests pack small fixture packages, so they need `npm`, `git`
and `tar`.
The `pack`, `publish`, `verify` and `finish` script modes are reserved for the
enabled, tagged GitHub workflow.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the
OIDC and public provenance requirements.
