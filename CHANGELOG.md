# Changelog

Notes for breaking changes and new features in releases from v0.15.0 on. Earlier releases are described on the [Releases page](https://github.com/NeverBlink-OSS/linkml-scala-action/releases).

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
