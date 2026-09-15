# Result Contract

The shared schemas and TypeScript types live in `shared/results.ts`.
Collectors call `parseRunBundle` before writing JSON. The dashboard uses that
parser when loading bundles.

## Run Bundles

Store one immutable JSON bundle per workflow run and attempt. The identity is
`run.id` plus `run.attempt`. A retry has its own bundle. Commit SHAs may repeat.

| Field | Contents |
| --- | --- |
| `schemaVersion` | Storage format version, currently `1` |
| `source` | `synthetic` for fixtures, `published` for CI measurements, or `local` for local measurements |
| `run` | Workflow ID, attempt, UTC creation time, workflow name and URL |
| `run.commit` | Full commit SHA, tree SHA, message and commit URL |
| `run.pullRequest` | Optional repository, PR number, head SHA and base SHA. Required for promotion |
| `catalog.runtimes` | Stable IDs, guest engines, execution modes and display text |
| `catalog.platforms` | Stable platform IDs and display labels |
| `catalog.metrics` | Metric IDs, units, direction and measurement method versions |
| `benchmark` | Workload ID, version, settings, required metrics and expected matrix |
| `runners` | Runner records scoped to this workflow attempt |
| `measurements` | Results linked to a runner and runtime |

Runtime and metric IDs are extensible strings. Lifecycle IDs are `reload`,
`reuse`, and `new`. The dashboard displays Restore, Reuse, and Renew.
Execution modes are `host`, `native`, `wasm-jit`, `wasm-aot`, and `wasm-pulley`.

`benchmark.settings` contains JSON values for settings that affect comparisons.
The HTTP fixture records `durationSeconds`, `concurrency`, `poolSize`, and
`requestTimeoutMs`. A collector's trusted benchmark policy defines required
settings and their values.

Each expected configuration identifies a runtime, platform, and lifecycle.
Each measurement identifies its `runnerId`, `runtimeId`, and lifecycle. The
runner supplies the platform. The format permits one result per configuration.

## Runner Records

Each runner records its name, job, pool, actual SKU, expected SKU, region, OS
version, architecture, CPU model, logical processor count, core count, threads
per core, memory bytes, tool versions, and dependency versions.

The collector reads actual machine metadata during the run. Expected SKUs come
from trusted pool configuration. Every recorded runner must match its expected
SKU. Publication also checks the SKU against a trusted policy.

Fixtures use null for unknown region, OS version, and CPU topology fields.
Published records require these fields and tool and dependency versions.

Local records use `local` for pool and SKU and null for Azure region.
They record host OS, CPU, memory, and tool details. Workflow and commit URLs
may be null. Local bundles cannot be archived or promoted by the CI publisher.

## Measurements

* `success` carries a `values` record keyed by metric ID. Values must be finite
  and nonnegative. Zero is a valid measurement.
* `failed` and `skipped` carry a reason.
* An expected configuration with an absent result is missing.

Successful results must contain each metric listed in `benchmark.metricIds`.
Units and method versions come from the bundle's metric catalog.

`rawOutputs` retains available output as JSON or text, with the producing tool
name. Keep benchmark summaries here. Build logs, binaries, and large traces
belong in workflow artifacts.

Memory method version 2 reports the maximum of periodic RSS samples and a
shutdown sample. Local smoke runs use `requestCount: 1`, `durationSeconds: 0`,
one connection, and a 120-second client timeout. They verify execution rather
than performance stability.

## Validation

`parseRunBundle` checks schema versions, field types, unique IDs, references,
metric coverage, configuration uniqueness, and runner SKU agreement. It accepts
partial runs for inspection. Additive metadata fields are retained.

`validateCompleteRun` requires a successful result for every configuration
declared in the bundle.

`validatePublishableRun` additionally requires measured provenance and a trusted
policy containing `catalog`, `benchmark`, and `expectedSkus`. The catalog and
benchmark use the bundle field schemas. `expectedSkus` maps platform IDs to
Azure SKU strings. Build the policy from the collector's trusted configuration.

The publication policy must match catalog definitions, workload settings,
required metric IDs, and expected configurations. Object key order and catalog
entry order do not affect comparison.

```sh
npm run validate -- --fixtures
npm run validate -- run.json
npm run validate -- --complete run.json
npm run validate -- --policy policy.json run.json
```

The command accepts multiple files and exits with status 1 on validation failure.
It partitions the supplied bundles into compatible dashboard histories and
validates each group.

## Dashboard Selection Archives

Downloads use `schemaVersion: 1` and `kind: "selection"`. `bundles` contains the
complete run records in the selected history range. `selection` records the
metric, lifecycle, runtime IDs, platform IDs, and selected run key.

The run key is `<run.id>.<run.attempt>`. Chart filters affect the selection record.
All measurements, raw outputs, and provenance remain in the bundled records.
`runSelectionSchema` validates the archive and selection references.

## History Index

The data branch stores `index.json` and immutable run bundles:

```text
index.json
runs/<run.id>/<run.attempt>.json
```

The local dashboard uses this format under `public/local-data/` for complete
local runs. Production Pages accepts only published bundles.

The index lists published workflow attempts:

```json
{
  "schemaVersion": 1,
  "runs": [
    { "id": "123456789", "attempt": 1 }
  ]
}
```

Use `{"schemaVersion":1,"runs":[]}` for an empty history.
`historyIndexSchema` validates the index and rejects duplicate attempts.
`historyRunPath` derives each bundle path relative to the index URL.
Paths contain the recorded workflow ID and attempt, independent of chart labels.

`parseHistoryRun` requires a complete measured bundle whose identity matches
the index entry. The dashboard sorts runs by creation time and run key.
It rejects the history if any referenced bundle fails to load or validate.
The loader fetches up to eight bundles concurrently and revalidates HTTP caches.

Only eligible published runs belong in this index. Pending PR runs stay separate.
A publisher must validate each bundle against its trusted publication policy,
write the immutable bundle, then update the index. Repeated writes must reject
conflicting content. Copy the index and its `runs/` directory together when
exporting a serving copy for Pages.

Publication records and the local publisher are separate from this reader.
`VITE_HISTORY_URL` selects the index URL at build time. The default points to
the public repository's data branch. `?demo=1` selects synthetic bundles and
does not fetch published history.

### Preview Indexes

A preview serving copy adds `preview` to its history index:

```json
{
  "schemaVersion": 1,
  "runs": [{ "id": "123456789", "attempt": 1 }],
  "preview": {
    "number": 7,
    "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "pending": { "id": "123456789", "attempt": 1 }
  }
}
```

`pending` is null when the preview has no current pending measurements. Its
identity must appear in `runs`. The referenced bundle must record the preview
PR number and head. The assembler also verifies the repository and current base.
It copies the bundle unchanged and marks its pending status in serving metadata.

Production indexes have no preview metadata. The production serving copy contains
only published bundles. Each preview has its own `data/index.json` and `data/runs/`.
The dashboard defaults to the pending run's compatible history. Older histories
remain selectable. The header indicates when pending results belong to another
history.

## Publication Records

`scripts/publish-results.ts` operates on a local data directory.
`store` validates a bundle against the shared publication policy and writes
`runs/<run.id>/<run.attempt>.json`. Stored runs remain outside published history
until promotion. A repeated store accepts identical JSON content and rejects
conflicts. Object key order and whitespace do not affect equality.

`promote` takes a publication record with these fields:

| Field | Contents |
| --- | --- |
| `schemaVersion` | `1` |
| `run.id` | Stored workflow run ID |
| `run.attempt` | Selected workflow attempt |
| `pullRequest.repository` | GitHub `owner/repository` |
| `pullRequest.number` | Positive PR number |
| `pullRequest.head` | Full PR head commit SHA |
| `pullRequest.base` | Full base commit SHA of the measured candidate |
| `merge.sha` | Full merged commit SHA |
| `merge.tree` | Full merged source tree SHA |
| `merge.mergedAt` | UTC merge timestamp |

The measured bundle must record the matching `run.pullRequest` object.
Its workflow URL must identify the repository, run and attempt. Its commit URL
must identify the measured commit in that repository. The merged tree must
equal `run.commit.tree`. A squash merge may have a different commit SHA.

Promotion revalidates the stored run against the trusted policy. It also loads
the indexed runs and validates each compatible group. It writes an immutable
`publications/pr-<number>.json` record, then updates `index.json`.
One data directory belongs to one repository. Each PR selects one attempt.
Conflicting publication records fail. The measured bundle remains unchanged.

```sh
npm run results:store -- --directory ./data-store run.json
npm run results:publish -- --directory ./data-store publication.json
```

The default policy comes from `shared/catalog.ts`. Use `--policy policy.json`
when the measured revision requires another trusted policy. Never accept a
publication policy supplied by untrusted PR code.

These are local consistency checks, not proof that a PR merged. A trusted CI
job must obtain GitHub merge metadata, verify the approved PR revisions and
workflow attempt, verify required checks and skip eligibility, and obtain the
actual merged tree before invoking promotion. PR code must not control this
job's scripts or provenance inputs. `scripts/publish-ci.ts` performs these GitHub
checks from the trusted publication workflow.

CI retains the trusted publication policy under `policies/<run.id>/<attempt>.json`
and a pending pointer under `pending/pr-<number>.json`. Pending pointers do not
enter the history index. Promotion uses the archived policy. Pending bundles and
pointers remain available after merge for recovery and audit.
Archival is pushed before promotion when a run finishes after merge. A promotion
failure leaves the validated archive available for retry.

### Write Recovery

Each command takes an exclusive `.publication-lock` directory. Concurrent
writers fail immediately. JSON files are prepared beside their destination.
Immutable writes use an exclusive hard link. Index replacement uses rename.
The filesystem must support these operations.

A failure after the publication record is written may leave the index unchanged.
Retry the identical promotion to finish updating it. A terminated process may
leave the lock directory or temporary files. Confirm that its writer has stopped
before removing those files and retrying. Temporary files end in `.tmp`.

The lock coordinates writers using one local directory. The CI publisher uses a
shared workflow concurrency group and ordinary Git pushes for remote updates.
Push conflicts fail and require a retry. The local commands do not perform Git
operations or remove PR previews. Approved benchmark-skip PRs do not invoke promotion.

## History Compatibility

The index retains every published run. Publication and Pages partition runs by
workload ID, version, settings, metric definitions, and runtime definitions.
Changes to metric units, directions, method versions, guest engines, execution
modes, or the set of metrics or runtimes start a separate group. Display labels
and catalog ordering do not affect grouping.

The dashboard compares one group at a time. It defaults to the group containing
the newest run. The Benchmark history selector exposes older groups. Shared
links identify a group through `history=<run.id>.<run.attempt>` using a member
run. Downloads contain only the selected group's visible runs.

Duplicate run identities and mixed local, synthetic, or published sources fail
validation. Each group retains strict comparison checks. No archived bundles
are rewritten when a new group is published.

The snapshot table shows successful results for the selected metric. Runner
specifications come from the selected run and platform filters.

Version measurement methods and workloads independently of `schemaVersion`.
Storage schema changes require an explicit reader migration.