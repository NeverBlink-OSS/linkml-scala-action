# linkml-scala-action

A GitHub Action to **validate** and **generate from** [LinkML](https://linkml.io) schemas in CI, powered by [linkml-scala](https://github.com/NeverBlink-OSS/linkml-scala).

- 🚀 **Pure Node.js** – no Docker, no JVM, no Python, no binary download. Uses the [`@neverblink/linkml`](https://www.npmjs.com/package/@neverblink/linkml) npm package.
- 🖥️ **Runs everywhere** – Linux, macOS, and Windows runners.
- 🏷️ **Inline annotations** – schema problems posted as GitHub annotations (on the PR "Files changed" tab and the check summary), pinned to a line and column when the engine reports one.
- ⚡ **Fast** – validating a schema is a few milliseconds after Node starts up.

## Quick start

Validate every schema in your repo on each push:

```yaml
name: linkml
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: NeverBlink-OSS/linkml-scala-action@v1
        with:
          files: "schemas/**/*.yaml"
```

Generate JSON Schema and commit/upload it as an artifact:

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v1
        with:
          command: generate
          generator: json-schema
          files: "schemas/**/*.yaml"
          output: build/json-schema
      - uses: actions/upload-artifact@v4
        with:
          name: json-schema
          path: build/json-schema
```

Fail the build on warnings too:

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v1
        with:
          files: "schemas/**/*.yaml"
          strict: true
```

## Inputs

| Input               | Default    | Description |
|---------------------|------------|-------------|
| `command`           | `validate` | `validate` or `generate`. |
| `files`             | *required* | Schema files. Space/newline-separated; globs incl. `**` supported. |
| `strict`            | `false`    | Treat warnings as failures. Errors always fail; warnings only with this on. |
| `generator`         | –          | **generate:** `json-schema`, `shacl`, `rdfs`, `linkml`, `table-schema`, `graphql`, or `scala`. |
| `output`            | –          | **generate:** output directory (one file per input schema). If omitted, output is printed to the job log. |
| `open`              | `false`    | **generate json-schema/shacl:** allow additional properties (open shapes). |
| `package`           | `linkml`   | **generate scala:** target package name. |
| `imports`           | –          | Directory of extra `.yaml` schemas made available to `imports:` (keyed by path, relative to `working-directory`). |
| `ignore`            | –          | Newline-separated substrings of problems to silence. |
| `annotations`       | `true`     | Emit GitHub error/warning annotations. |
| `working-directory` | `.`        | Base directory for resolving `files`, `imports`, and `output`. |

## Outputs

| Output           | Description |
|------------------|-------------|
| `problems`       | Total number of problems found across all schemas. |
| `files`          | Number of schema files processed. |
| `linkml-version` | The bundled linkml-scala version. |

## Behavior

Loading a schema validates it, so both commands report the same problems. Each has a severity:

| Severity  | Meaning | Effect |
|-----------|---------|--------|
| `FATAL`   | The schema could not be loaded at all (unparseable YAML, an unresolvable import, an unknown class reference). | Fails the step. Nothing is generated from the schema. |
| `ERROR`   | The schema loaded but is invalid (e.g. two `tree_root` classes, a non-unique name). | Fails the step. Generation still runs, so the output is there to inspect. |
| `WARNING` | Advisory (e.g. no `tree_root` class). | Reported only; fails the step when `strict: true`. |

- **Generators** write one output file per input schema into `output`, named after the schema (`person.yaml` → `person.schema.json`). The `scala` generator can emit multiple files per schema, so those go under `output/<schema-name>/`.
- **Imports:** if your schemas use `imports: [shared]`, point `imports` at a directory containing `shared.yaml`. Files are keyed by filename.
- **`ignore`** silences a problem of any severity whose message contains one of the given substrings. Silenced problems are still logged (prefixed `(ignored)`) but are not annotated, not counted in `problems`, and do not affect the exit code.

## Resolving imports – example

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v1
        with:
          command: generate
          generator: shacl
          files: "schemas/main.yaml"        # e.g. imports: [common/types]
          imports: "schemas"                # dir holding schemas/common/types.yaml
          output: build/shacl
```

## Versioning

The linkml-scala engine version is bundled into each release of this action, so the action version tracks the engine version:

- Pin an **exact tag** (e.g. `@v0.9.2`) for reproducibility.
- Pin the **moving major tag** `@v1` for automatic patch/minor updates.

New engine releases are picked up automatically by the [`track-linkml-scala`](.github/workflows/track-linkml-scala.yml) workflow, which bumps the bundled engine, rebuilds, re-runs the test suite against it, and – only if that passes – cuts the matching `vX.Y.Z` release and advances `vX`. It runs daily and can also be triggered manually (with an optional target version and a dry-run mode).

## Development

```bash
npm ci
npm run build   # bundles src/ + @neverblink/linkml into dist/index.cjs (committed)
npm test        # simulates the Actions runtime and asserts behavior
```

The bundled `dist/` is committed so the action needs no install step at runtime; CI
verifies it stays in sync with `src/`.

## License

[Apache-2.0](LICENSE).

This project is being developed and maintained by [NeverBlink](https://neverblink.eu). For any inquiries, please reach out to us via [email](mailto:contact@neverblink.eu).
