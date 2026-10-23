# Changelog

Notes for breaking changes and new features in releases from v0.15.0 on. Earlier releases are described on the [Releases page](https://github.com/NeverBlink-OSS/linkml-scala-action/releases).

## Unreleased

### Fixed

- An `import-map` prefix entry whose location is `working-directory` itself, such as `{"https://w3id.org/linkml/": "./"}`, loads imports from that directory. It used to look for them at the root of the file system, e.g. `/types.yaml`.

## v0.17.1

Bundles [`@neverblink/linkml@0.17.1`](https://github.com/NeverBlink-OSS/linkml-scala/releases/tag/v0.17.1).

### Added

- `import-map` input for `validate` and `generate` – a JSON import map, as taken by linkml-scala's `--import-map`, that says where to load imports from without changing the schema. Local locations are relative to `working-directory` and are read from disk.

## v0.17.0

Bundles [`@neverblink/linkml@0.17.0`](https://github.com/NeverBlink-OSS/linkml-scala/releases/tag/v0.17.0).

### Added

- `generator: owl` – generate an OWL 2 ontology. Takes `format` (`ttl`/`nt`), `only-root-schema`, `metadata-profile` and `permissible-values`.
- `importer: owl` – read an OWL ontology or RDFS vocabulary into a LinkML schema. Takes `config` (a mapping config file), `schema-id`, `input-format`, `list-not-imported`, `format`, and `imports` for the schemas the config maps `owl:imports` to.
- `generator: typescript` and `generator: pydantic` – TypeScript types and pydantic classes for the JSON the JSON Schema describes. Take `pruning-mode`, `tree-root`, `open` and `include-null`.
- `generator: er-diagram` – a Mermaid ER diagram. Takes `pruning-mode`, `tree-root` and `optional-marker`.
- `generator: translation` – JSON dictionaries from LinkML names to a framework's names. Takes `target` and `derived-attributes`.
- More options for the existing generators: `tree-root` for `json-schema`; `pruning-mode`, `tree-root`, `skip-derivation` and `format` (`yaml`/`json`) for `linkml`; `pruning-mode` and `tree-root` for `graphql`; `only-root-schema` for `shacl` and `rdfs`.

## v0.16.1

### Added

- `generator: ossie` – generate an [Apache Ossie](https://github.com/apache/ossie) ontology from a LinkML schema. Honours `pruning-mode` and `tree-root`, and writes YAML or JSON (`format`).
- `command: import` with `importer: ossie` – the opposite direction: read an Ossie ontology and write the LinkML schema it describes. `schema-id` sets the `id` of that schema; `format` picks YAML or JSON.

### Changed

- `format` now depends on the generator: `ttl`/`nt` for `shacl` and `rdfs` (unchanged), `yaml`/`json` for `ossie` and for `import`. A generator that takes no format ignores the input instead of rejecting an unknown value.

## v0.15.0

Bundles [`@neverblink/linkml@0.15.0`](https://github.com/NeverBlink-OSS/linkml-scala/releases/tag/v0.15.0).

### Breaking

- `generator: table-schema` is now `generator: frictionless`.
- `frictionless` writes a whole data package – `datapackage.json` plus one `schemas/<table>.json` per table under `output/<schema-name>/`, instead of a single `<schema>.table.json`.
- `shacl` and `rdfs` emit Turtle by default, as `<schema>.shacl.ttl` / `<schema>.rdfs.ttl`. Set `format: nt` for the previous N-Triples output.
- `ignore` takes issue type names (`NoTreeRootClass`, `UnknownReference`, …), matched exactly and case-insensitively, instead of message substrings.

### Added

- `format` input (`ttl` | `nt`) for `shacl` and `rdfs`.
- Every reported problem now ends with its issue type in square brackets.
