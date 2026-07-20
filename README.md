# linkml-scala-action

A GitHub Action to **validate** and **generate from** [LinkML](https://linkml.io) schemas in CI, powered by [linkml-scala](https://github.com/NeverBlink-OSS/linkml-scala).

- 🚀 **Pure Node.js** – no Docker, no JVM, no Python, no binary download. Uses the [`@neverblink/linkml`](https://www.npmjs.com/package/@neverblink/linkml) npm package.
- 🖥️ **Runs everywhere** – Linux, macOS, and Windows runners.
- 🏷️ **Inline annotations** – schema problems posted as GitHub annotations (on the PR "Files changed" tab and the check summary).
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
| `strict`            | `false`    | **validate:** treat warnings as failures. |
| `generator`         | –          | **generate:** `json-schema`, `shacl`, `rdfs`, `linkml`, `table-schema`, or `scala`. |
| `output`            | –          | **generate:** output directory (one file per input schema). If omitted, output is printed to the job log. |
| `open`              | `false`    | **generate json-schema/shacl:** allow additional properties (open shapes). |
| `package`           | `linkml`   | **generate scala:** target package name. |
| `imports`           | –          | Directory of extra `.yaml` schemas made available to `imports:` (keyed by filename). |
| `annotations`       | `true`     | Emit GitHub error/warning annotations. |
| `working-directory` | `.`        | Base directory for resolving `files`, `imports`, and `output`. |

## Outputs

| Output           | Description |
|------------------|-------------|
| `problems`       | Total number of problems found across all schemas. |
| `files`          | Number of schema files processed. |
| `linkml-version` | The bundled linkml-scala version. |

## Behavior

- **Validation** uses the linkml-scala linter. **Fatal** problems (e.g. an unknown class reference) fail the step. **Warnings** are reported but only fail the step when `strict: true`.
- **Generators** write one output file per input schema into `output`, named after the schema (`person.yaml` → `person.schema.json`). The `scala` generator can emit multiple files per schema, so those go under `output/<schema-name>/`.
- **Imports:** if your schemas use `imports: [shared]`, point `imports` at a directory containing `shared.yaml`. Files are keyed by filename.

## Resolving imports – example

```yaml
      - uses: NeverBlink-OSS/linkml-scala-action@v1
        with:
          command: generate
          generator: shacl
          files: "schemas/main.yaml"
          imports: "schemas/common"   # dir containing e.g. types.yaml, core.yaml
          output: build/shacl
```

## Versioning

The linkml-scala engine version is bundled into each release of this action. The action version tracks the engine version (e.g. `@v0.9.2`). Pin to the moving major tag `@v1` for automatic patch/minor updates, or to an exact tag for reproducibility.

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
