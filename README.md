# linkml-scala-action

A GitHub Action to **validate**, **generate from** and **import into** [LinkML](https://linkml.io) schemas in CI, powered by [linkml-scala](https://github.com/NeverBlink-OSS/linkml-scala).

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
      - uses: NeverBlink-OSS/linkml-scala-action@v0.16.3
        with:
          files: "schemas/**/*.yaml"
```

Generate JSON Schema and commit/upload it as an artifact:

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.16.3
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
      - uses: NeverBlink-OSS/linkml-scala-action@v0.16.3
        with:
          files: "schemas/**/*.yaml"
          strict: true
```

Turn an [Apache Ossie](https://github.com/apache/ossie) ontology into a LinkML schema:

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.16.3
        with:
          command: import
          importer: ossie
          files: "ontologies/*.yaml"
          output: schemas
```

See [CHANGELOG.md](CHANGELOG.md) for what changed between releases.

## Inputs

| Input               | Default    | Description |
|---------------------|------------|-------------|
| `command`           | `validate` | `validate`, `generate`, or `import`. |
| `files`             | *required* | Files to process – LinkML schemas, or the documents to read for `import`. Space/newline-separated; globs incl. `**` supported. |
| `strict`            | `false`    | Treat warnings as failures. Errors always fail; warnings only with this on. |
| `generator`         | –          | **generate:** `json-schema`, `shacl`, `rdfs`, `linkml`, `frictionless`, `graphql`, `ossie`, or `scala`. |
| `importer`          | –          | **import:** the format to read and turn into a LinkML schema. Currently only `ossie` (an [Apache Ossie](https://github.com/apache/ossie) ontology). |
| `output`            | –          | **generate/import:** output directory (one file per input). If omitted, output is printed to the job log. |
| `open`              | `false`    | **generate json-schema/shacl:** allow additional properties (open shapes). |
| `format`            | see desc.  | Output serialization. **generate shacl/rdfs:** `ttl` (Turtle, prefixed and pretty-printed, the default) or `nt` (N-Triples). **generate ossie / import:** `yaml` (the default) or `json`. Other generators take no format. |
| `package`           | `linkml`   | **generate scala:** target package name. |
| `pruning-mode`      | `skip`     | **generate frictionless/ossie:** which classes become tables (`frictionless`) or which elements become concepts (`ossie`) – `treeRoot` (only those reachable from the `tree_root` class), `schema` (only those reachable from a class defined in the root schema), or `skip` (all of them). |
| `tree-root`         | –          | **generate frictionless/ossie:** tree root class name to use instead of the schema's own `tree_root`. Only has an effect with `pruning-mode: treeRoot`. |
| `skip-classes-without-identifier` | `false` | **generate frictionless:** skip classes with no identifier slot. Such a table gets no primary key and nothing can reference it. |
| `schema-id`         | –          | **import:** the `id` of the LinkML schema to produce. Defaults to a placeholder built from the source document's name. Only valid when a single file is imported. |
| `imports`           | –          | **validate/generate:** directory of extra `.yaml` schemas made available to `imports:` (keyed by path, relative to `working-directory`). |
| `ignore`            | –          | Newline-separated issue type names to silence, one per line. |
| `annotations`       | `true`     | Emit GitHub error/warning annotations. |
| `working-directory` | `.`        | Base directory for resolving `files`, `imports`, and `output`. |

## Outputs

| Output           | Description |
|------------------|-------------|
| `problems`       | Total number of problems found across all schemas. |
| `files`          | Number of files processed. |
| `linkml-version` | The bundled linkml-scala version. |

## Behavior

Loading a schema validates it, so `validate` and `generate` report the same problems. Each has a severity:

| Severity  | Meaning | Effect |
|-----------|---------|--------|
| `FATAL`   | The schema could not be loaded at all (unparseable YAML, an unresolvable import, an unknown class reference). | Fails the step. Nothing is generated from the schema. |
| `ERROR`   | The schema loaded but is invalid (e.g. two `tree_root` classes, a non-unique name). | Fails the step. Generation still runs, so the output is there to inspect. |
| `WARNING` | Advisory (e.g. no `tree_root` class). | Reported only; fails the step when `strict: true`. |

- **Generators** write one output file per input schema into `output`, named after the schema (`person.yaml` → `person.schema.json`). The `scala` and `frictionless` generators emit multiple files per schema, so those go under `output/<schema-name>/` (for `frictionless`, a `datapackage.json` plus one `schemas/<table>.json` per table).
- **`import`** goes the other way: its inputs are not LinkML schemas but documents in another format, so nothing is validated and no problems are reported – the only thing that can go wrong is the engine rejecting a document. Each input produces one schema, named after it (`person.ontology.yaml` → `person.ontology.linkml.yaml`). `generate ossie` and `import ossie` are the two directions of the same conversion, so a schema can be round-tripped through an ontology and back.
- **Imports:** if your schemas use `imports: [shared]`, point `imports` at a directory containing `shared.yaml`. Files are keyed by filename.
- **`ignore`** silences problems by *issue type*. Every problem the engine reports is tagged with the class it belongs to in the validation report.

## Resolving imports – example

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.16.3
        with:
          command: generate
          generator: shacl
          files: "schemas/main.yaml"        # e.g. imports: [common/types]
          imports: "schemas"                # dir holding schemas/common/types.yaml
          output: build/shacl
```

## Versioning

The linkml-scala engine version is bundled into each release of this action, so the action version tracks the engine version. Pin an exact tag:

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.16.3
```

New engine releases are picked up automatically by the [`track-linkml-scala`](.github/workflows/track-linkml-scala.yml) workflow, which bumps the bundled engine, rebuilds, re-runs the test suite against it, updates the examples above, and – only if that passes – cuts the matching `vX.Y.Z` release. It runs daily and can also be triggered manually (with an optional target version and a dry-run mode).

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
