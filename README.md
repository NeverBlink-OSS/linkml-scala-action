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
      - uses: NeverBlink-OSS/linkml-scala-action@v0.17.2
        with:
          files: "schemas/**/*.yaml"
```

Generate JSON Schema and commit/upload it as an artifact:

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.17.2
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
      - uses: NeverBlink-OSS/linkml-scala-action@v0.17.2
        with:
          files: "schemas/**/*.yaml"
          strict: true
```

Turn an [Apache Ossie](https://github.com/apache/ossie) ontology into a LinkML schema:

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.17.2
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
| `generator`         | –          | **generate:** `json-schema`, `shacl`, `rdfs`, `owl`, `linkml`, `frictionless`, `graphql`, `typescript`, `pydantic`, `er-diagram`, `translation`, `ossie`, or `scala`. |
| `importer`          | –          | **import:** the format to read and turn into a LinkML schema – `ossie` (an [Apache Ossie](https://github.com/apache/ossie) ontology) or `owl` (an OWL ontology or RDFS vocabulary in Turtle or N-Triples). |
| `output`            | –          | **generate/import:** output directory (one file per input). If omitted, output is printed to the job log. |
| `format`            | see desc.  | Output serialization. **generate shacl/rdfs/owl:** `ttl` (Turtle, prefixed and pretty-printed, the default) or `nt` (N-Triples). **generate linkml/ossie, import:** `yaml` (the default) or `json`. Other generators take no format. |
| `open`              | `false`    | **generate json-schema/shacl/typescript/pydantic:** allow additional properties (open shapes) for every class, not only those whose `extra_slots` allows them. |
| `pruning-mode`      | see desc.  | **generate linkml/frictionless/graphql/typescript/pydantic/er-diagram/ossie:** which elements to keep – `treeRoot` (only those reachable from the `tree_root` class), `schema` (only those reachable from a class defined in the root schema), or `skip` (all of them). If omitted, each generator uses its own default: `treeRoot` for `linkml`, `graphql` and `er-diagram`, `skip` for the others. |
| `tree-root`         | –          | **generate json-schema/linkml/frictionless/graphql/typescript/pydantic/er-diagram/ossie:** tree root class name to use instead of the schema's own `tree_root`. For `linkml`, `frictionless` and `ossie` it only has an effect with `pruning-mode: treeRoot`. |
| `only-root-schema`  | `false`    | **generate shacl/rdfs/owl:** describe only the classes of the root schema, not those of the schemas it imports. For `owl`, each imported schema gets an `owl:imports` instead. |
| `metadata-profile`  | `rdfs`     | **generate owl:** where descriptions go – `rdfs` (`rdfs:comment`) or `linkml` (`skos:definition`, as in the LinkML metamodel). |
| `permissible-values` | `individual` | **generate owl:** what permissible values become – `individual` or `class`. |
| `skip-derivation`   | `false`    | **generate linkml:** copy classes as they are instead of deriving them. |
| `include-null`      | `false`    | **generate typescript:** optional slots may also be `null`. **generate pydantic:** dumps keep the nulls that were loaded or set. |
| `optional-marker`   | `true`     | **generate er-diagram:** mark optional attributes with a trailing `?` on their type. Mermaid understands this from version 11.16; turn it off for older renderers, which throw an error on it. |
| `target`            | `base`     | **generate translation:** the framework to translate LinkML names to – `base`, `uri`, `scala`, `graphql`, `frictionless`, `ossie`, `erdiagram`, `json`, `typescript`, or `pydantic`. |
| `derived-attributes` | `false`   | **generate translation:** also list inherited slots, mixin slots and slots from the class's `slots` list in `classAttributes`. |
| `package`           | `linkml`   | **generate scala:** target package name. |
| `skip-classes-without-identifier` | `false` | **generate frictionless:** skip classes with no identifier slot. Such a table gets no primary key and nothing can reference it. |
| `schema-id`         | –          | **import:** the `id` of the LinkML schema to produce. Defaults to a placeholder built from the document's name (`ossie`) or to the ontology IRI (`owl`). Only valid when a single file is imported. For `owl`, it replaces any `schema_id` in `config`. |
| `config`            | –          | **import owl:** path to a YAML or JSON file that changes how the ontology is mapped – names, prefixes, which annotation properties fill which metaslots, which `owl:imports` map to which LinkML schemas. See [linkml-scala's OWL docs](https://github.com/NeverBlink-OSS/linkml-scala/blob/main/docs/owl.md#config). |
| `input-format`      | `ttl`      | **import owl:** RDF syntax of the ontology – `ttl` (Turtle, which also reads N-Triples) or `nt` (N-Triples). |
| `list-not-imported` | `false`    | **import owl:** list what could not be imported (property chains, individuals, …) in comments at the top of the schema. |
| `imports`           | –          | Directory of extra `.yaml` schemas. **validate/generate:** made available to `imports:` (keyed by path, relative to `working-directory`). **import owl:** the LinkML schemas that `config` maps `owl:imports` to (keyed by path, relative to `output`). |
| `import-map`        | –          | **validate/generate:** path to a JSON [import map](https://github.com/NeverBlink-OSS/linkml-scala/blob/main/docs/import_maps.md) (the format of linkml-scala's `--import-map`) that says where to load imports from, without changing the schema. Local locations are relative to `working-directory` and are read from disk. |
| `ignore`            | –          | Newline-separated issue type names to silence, one per line. |
| `annotations`       | `true`     | Emit GitHub error/warning annotations. |
| `working-directory` | `.`        | Base directory for resolving `files`, `imports`, `import-map`, `config`, and `output`. |

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

- **Generators** write one output file per input schema into `output`, named after the schema (`person.yaml` → `person.schema.json`):

  | Generator     | Output |
  |---------------|--------|
  | `json-schema` | `person.schema.json` |
  | `shacl`       | `person.shacl.ttl` (or `.nt`) |
  | `rdfs`        | `person.rdfs.ttl` (or `.nt`) |
  | `owl`         | `person.owl.ttl` (or `.nt`) |
  | `linkml`      | `person.materialized.yaml` (or `.json`) |
  | `graphql`     | `person.graphql` |
  | `typescript`  | `person.ts` |
  | `pydantic`    | `person.py` |
  | `er-diagram`  | `person.mmd` (a Mermaid ER diagram) |
  | `translation` | `person.translation.<target>.json` |
  | `ossie`       | `person.ossie.yaml` (or `.json`) |
  | `scala`       | `person/*.scala` |
  | `frictionless` | `person/datapackage.json` plus one `person/schemas/<table>.json` per table |

- **Imports:** if your schemas use `imports: [shared]`, point `imports` at a directory containing `shared.yaml`. Files are keyed by filename.
- **`ignore`** silences problems by *issue type*. Every problem the engine reports is tagged with the class it belongs to in the validation report.

## Resolving imports – example

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.17.2
        with:
          command: generate
          generator: shacl
          files: "schemas/main.yaml"        # e.g. imports: [common/types]
          imports: "schemas"                # dir holding schemas/common/types.yaml
          output: build/shacl
```

## Import maps – example

A schema that imports another one by URI or CURIE, such as `units:core` with the prefix `units: https://example.org/units/`, can be loaded from a local copy with an import map:

```json
{
  "https://example.org/units/": "deps/units/"
}
```

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.17.2
        with:
          files: "schemas/model.yaml"
          import-map: "imports.json"        # units:core → deps/units/core.yaml
```

A key ending in `/` or `#` matches every import that starts with it; any other key matches only that import. Keys are full URIs or paths, not CURIEs. See [linkml-scala's import map docs](https://github.com/NeverBlink-OSS/linkml-scala/blob/main/docs/import_maps.md) for how imports are matched.

## Versioning

The linkml-scala engine version is bundled into each release of this action, so the action version tracks the engine version. Pin an exact tag:

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v0.17.2
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
