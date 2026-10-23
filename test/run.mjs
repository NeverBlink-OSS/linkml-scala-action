// Simulates the GitHub Actions runtime: sets INPUT_* + GITHUB_OUTPUT, runs the
// bundled action, and asserts on exit code, annotations, and step outputs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Defaults to the bundled action; override with ACTION_ENTRY to measure
// coverage against src/ (e.g. c8 --include 'src/**' node test/run.mjs).
const ENTRY = process.env.ACTION_ENTRY
  ? path.resolve(ROOT, process.env.ACTION_ENTRY)
  : path.join(ROOT, "dist", "index.cjs");

let failures = 0;
function run(name, inputs, expect) {
  const outFile = path.join(mkdtempSync(path.join(tmpdir(), "ghout-")), "out.txt");
  const env = { ...process.env, GITHUB_OUTPUT: outFile };
  for (const [k, v] of Object.entries(inputs)) {
    env["INPUT_" + k.toUpperCase().replace(/ /g, "_")] = String(v);
  }
  let code = 0;
  let stdout = "";
  try {
    stdout = execFileSync("node", [ENTRY], { env, encoding: "utf8" });
  } catch (e) {
    code = e.status ?? 1;
    stdout = (e.stdout || "") + (e.stderr || "");
  }
  const outputs = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";

  const problems = [];
  if (expect.code !== undefined && code !== expect.code)
    problems.push(`exit code: got ${code}, want ${expect.code}`);
  for (const s of expect.stdoutIncludes || [])
    if (!stdout.includes(s)) problems.push(`stdout missing: ${JSON.stringify(s)}`);
  for (const s of expect.stdoutExcludes || [])
    if (stdout.includes(s)) problems.push(`stdout unexpectedly has: ${JSON.stringify(s)}`);
  for (const s of expect.outputsInclude || [])
    if (!outputs.includes(s)) problems.push(`output missing: ${JSON.stringify(s)}`);
  for (const f of expect.filesExist || [])
    if (!existsSync(path.resolve(ROOT, f))) problems.push(`file not created: ${f}`);

  if (problems.length) {
    failures++;
    console.log(`✗ ${name}`);
    for (const p of problems) console.log(`    - ${p}`);
    console.log("    --- stdout ---\n" + stdout.split("\n").map((l) => "    " + l).join("\n"));
  } else {
    console.log(`✓ ${name}`);
  }
}

const outDir = mkdtempSync(path.join(tmpdir(), "gen-"));

run("validate valid schema passes", {
  command: "validate",
  files: "examples/person.yaml",
}, { code: 0, stdoutIncludes: ["✓ examples/person.yaml"], outputsInclude: ["problems<<", "0"] });

run("validate broken schema fails with error annotation", {
  command: "validate",
  files: "examples/broken.yaml",
}, {
  code: 1,
  stdoutIncludes: ["::error", "NonExistentClass"],
});

run("validate glob covers both files, fails overall", {
  command: "validate",
  files: "examples/**/*.yaml",
}, { code: 1, stdoutIncludes: ["examples/person.yaml", "examples/broken.yaml"] });

run("warning-only schema passes without --strict, emits ::warning", {
  command: "validate",
  files: "examples/warning.yaml",
}, { code: 0, stdoutIncludes: ["::warning", "tree_root"] });

run("--strict turns a warning into a failure", {
  command: "validate",
  files: "examples/warning.yaml",
  strict: "true",
}, { code: 1, stdoutIncludes: ["::warning"] });

run("generate json-schema to dir", {
  command: "generate",
  generator: "json-schema",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.schema.json")] });

run("generate shacl to log defaults to Turtle", {
  command: "generate",
  generator: "shacl",
  files: "examples/person.yaml",
}, { code: 0, stdoutIncludes: ["shacl", "PREFIX sh:"] });

run("format: nt switches shacl back to N-Triples (.shacl.nt)", {
  command: "generate",
  generator: "shacl",
  format: "nt",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.shacl.nt")] });

run("generate unknown format fails", {
  command: "generate",
  generator: "shacl",
  format: "xml",
  files: "examples/person.yaml",
}, { code: 1, stdoutIncludes: ["Unknown format"] });

run("generate unknown generator fails", {
  command: "generate",
  generator: "protobuf",
  files: "examples/person.yaml",
}, { code: 1, stdoutIncludes: ["Unknown generator"] });

run("no matching files fails", {
  command: "validate",
  files: "examples/does-not-exist-*.yaml",
}, { code: 1, stdoutIncludes: ["No schema files matched"] });

run("annotations can be disabled", {
  command: "validate",
  files: "examples/broken.yaml",
  annotations: "false",
}, { code: 1, stdoutExcludes: ["::error"] });

run("generate rdfs writes Turtle (.rdfs.ttl)", {
  command: "generate",
  generator: "rdfs",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.rdfs.ttl")] });

run("generate scala writes multiple files under <schema>/", {
  command: "generate",
  generator: "scala",
  package: "com.example",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person", "Person.scala")] });

run("generate frictionless writes a data package under <schema>/", {
  command: "generate",
  generator: "frictionless",
  files: "examples/tables.yaml",
  output: path.relative(ROOT, outDir),
}, {
  code: 0,
  filesExist: [
    path.join(path.relative(ROOT, outDir), "tables", "datapackage.json"),
    path.join(path.relative(ROOT, outDir), "tables", "schemas", "person.json"),
    path.join(path.relative(ROOT, outDir), "tables", "schemas", "address.json"),
  ],
});

run("frictionless pruning-mode is accepted case-insensitively", {
  command: "generate",
  generator: "frictionless",
  "pruning-mode": "treeroot",
  files: "examples/tables.yaml",
}, { code: 0, stdoutIncludes: ["datapackage.json"] });

run("frictionless skip-classes-without-identifier drops the keyless table", {
  command: "generate",
  generator: "frictionless",
  "skip-classes-without-identifier": "true",
  files: "examples/tables.yaml",
}, { code: 0, stdoutIncludes: ["schemas/person.json"], stdoutExcludes: ["schemas/address.json"] });

run("generate unknown pruning-mode fails", {
  command: "generate",
  generator: "frictionless",
  "pruning-mode": "everything",
  files: "examples/tables.yaml",
}, { code: 1, stdoutIncludes: ["Unknown pruning-mode"] });

run("generate on a fatally-broken schema fails", {
  command: "generate",
  generator: "json-schema",
  files: "examples/broken.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 1, stdoutIncludes: ["::error", "generation failed"] });

run("unknown command fails", {
  command: "frobnicate",
  files: "examples/person.yaml",
}, { code: 1, stdoutIncludes: ["Unknown command"] });

run("empty files input fails", {
  command: "validate",
  files: "   ",
}, { code: 1, stdoutIncludes: ["No `files` provided"] });

run("imports directory resolves cross-file references", {
  command: "generate",
  generator: "json-schema",
  files: "test/fixtures/imports/main.yaml",
  imports: "test/fixtures/imports/common",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "main.schema.json")] });

run("cyclic imports (a <-> b) validate via loadFromPath", {
  command: "validate",
  files: "test/fixtures/cyclic/*.yaml",
}, { code: 0, stdoutIncludes: ["a.yaml", "b.yaml"] });

// --- ignore: matches an issue's `issue_type` class name, exactly ------------

run("reported problems carry their issue type", {
  command: "validate",
  files: "examples/broken.yaml",
}, { code: 1, stdoutIncludes: ["::error", "[UnknownReference]"] });

run("ignore silences a matching warning (no annotation, logged)", {
  command: "validate",
  files: "examples/warning.yaml",
  ignore: "NoTreeRootClass",
}, { code: 0, stdoutIncludes: ["(ignored)"], stdoutExcludes: ["::warning"] });

run("ignored warning does not fail even under --strict", {
  command: "validate",
  files: "examples/warning.yaml",
  strict: "true",
  ignore: "NoTreeRootClass",
}, { code: 0, stdoutExcludes: ["::warning", "::error"] });

run("issue types are matched case-insensitively", {
  command: "validate",
  files: "examples/warning.yaml",
  ignore: "notreerootclass",
}, { code: 0, stdoutIncludes: ["(ignored)"], stdoutExcludes: ["::warning"] });

run("ignore silences a fatal issue type", {
  command: "validate",
  files: "examples/broken.yaml",
  ignore: "UnknownReference",
}, { code: 0, stdoutIncludes: ["(ignored)"], stdoutExcludes: ["::error"] });

run("one entry per line silences several issue types", {
  command: "validate",
  files: "examples/**/*.yaml",
  ignore: "UnknownReference\nNoTreeRootClass",
}, { code: 0, stdoutExcludes: ["::error", "::warning"] });

run("a non-matching issue type leaves the error in place", {
  command: "validate",
  files: "examples/broken.yaml",
  ignore: "MultipleTreeRoots",
}, { code: 1, stdoutIncludes: ["::error", "NonExistentClass"] });

// Exact match only, so a type name that is a prefix of another does not
// silence it.
run("a prefix of an issue type does not match it", {
  command: "validate",
  files: "examples/broken.yaml",
  ignore: "Unknown",
}, { code: 1, stdoutIncludes: ["::error", "NonExistentClass"] });

// The old behaviour was substring matching on the message; such an entry now
// fails loudly rather than silencing nothing.
run("message text in ignore is rejected", {
  command: "validate",
  files: "examples/broken.yaml",
  ignore: "Unknown reference",
}, { code: 1, stdoutIncludes: ["Not an issue type", "'Unknown reference'"] });

run("generate graphql writes a .graphql file", {
  command: "generate",
  generator: "graphql",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.graphql")] });

// --- structured reports (linkml-scala >= 0.12) --------------------------------

// ERROR sits between WARNING and FATAL: the schema is invalid, but it still
// loads. It must fail the run without --strict, unlike a warning.
run("an ERROR-severity problem fails validation without --strict", {
  command: "validate",
  files: "test/fixtures/errors/multiple-tree-roots.yaml",
}, { code: 1, stdoutIncludes: ["::error", "tree_root", "Alpha, Beta"] });

// ...and because the view still loads, generation runs and writes output while
// the run as a whole fails.
run("an ERROR-severity problem still generates output, but fails", {
  command: "generate",
  generator: "json-schema",
  files: "test/fixtures/errors/multiple-tree-roots.yaml",
  output: path.relative(ROOT, outDir),
}, {
  code: 1,
  stdoutIncludes: ["::error", "Alpha, Beta"],
  filesExist: [path.join(path.relative(ROOT, outDir), "multiple-tree-roots.schema.json")],
});

run("an ERROR-severity problem can be silenced with ignore", {
  command: "validate",
  files: "test/fixtures/errors/multiple-tree-roots.yaml",
  ignore: "MultipleTreeRoots",
}, { code: 0, stdoutIncludes: ["(ignored)"], stdoutExcludes: ["::error"] });

// A code_region in the report becomes a line/column on the annotation.
run("a parse error is annotated with a line and column", {
  command: "validate",
  files: "test/fixtures/errors/unparseable.yaml",
}, {
  code: 1,
  stdoutIncludes: ["::error", "line=", "col=", "Cannot parse schema"],
});

// An unresolvable import is a FATAL issue, not a thrown error; its reason lives
// in the issue's `details`, which is what the action reports.
run("an unresolvable import is reported as a fatal problem", {
  command: "validate",
  files: "test/fixtures/errors/missing-import.yaml",
}, {
  code: 1,
  stdoutIncludes: ["::error", "Cannot import schema", "Could not read from the imports"],
});

run("generate on an unresolvable import fails without output", {
  command: "generate",
  generator: "json-schema",
  files: "test/fixtures/errors/missing-import.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 1, stdoutIncludes: ["::error", "generation failed"] });

// --- Apache Ossie: the `ossie` generator and the `import` command -----------

run("generate ossie writes an ontology as YAML by default", {
  command: "generate",
  generator: "ossie",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.ossie.yaml")] });

run("format: json switches ossie to JSON (.ossie.json)", {
  command: "generate",
  generator: "ossie",
  format: "json",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.ossie.json")] });

// `format` is per-generator: an RDF serialization is not one of ossie's.
run("an RDF format is rejected for ossie", {
  command: "generate",
  generator: "ossie",
  format: "ttl",
  files: "examples/person.yaml",
}, { code: 1, stdoutIncludes: ["Unknown format", "yaml, json"] });

// ...and the other way round.
run("a document format is rejected for shacl", {
  command: "generate",
  generator: "shacl",
  format: "yaml",
  files: "examples/person.yaml",
}, { code: 1, stdoutIncludes: ["Unknown format", "ttl, nt"] });

run("import ossie turns an ontology back into a LinkML schema", {
  command: "import",
  importer: "ossie",
  files: "test/fixtures/ossie/person.ontology.yaml",
  output: path.relative(ROOT, outDir),
}, {
  code: 0,
  outputsInclude: ["problems<<", "0"],
  filesExist: [path.join(path.relative(ROOT, outDir), "person.ontology.linkml.yaml")],
});

run("import ossie can write the schema as JSON", {
  command: "import",
  importer: "ossie",
  format: "json",
  files: "test/fixtures/ossie/person.ontology.yaml",
  output: path.relative(ROOT, outDir),
}, {
  code: 0,
  filesExist: [path.join(path.relative(ROOT, outDir), "person.ontology.linkml.json")],
});

run("schema-id sets the id of the imported schema", {
  command: "import",
  importer: "ossie",
  "schema-id": "https://example.org/imported",
  files: "test/fixtures/ossie/person.ontology.yaml",
}, { code: 0, stdoutIncludes: ["id: https://example.org/imported"] });

// One id cannot be shared by several schemas, so this is refused rather than
// quietly applied to each of them.
run("schema-id with more than one input fails", {
  command: "import",
  importer: "ossie",
  "schema-id": "https://example.org/imported",
  files: "test/fixtures/ossie/*.yaml",
}, { code: 1, stdoutIncludes: ["schema-id", "2 files"] });

run("import rejects a document that is not an ontology", {
  command: "import",
  importer: "ossie",
  files: "test/fixtures/ossie/not-an-ontology.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 1, stdoutIncludes: ["::error", "import failed"] });

run("a rejected document can be silenced with ignore", {
  command: "import",
  importer: "ossie",
  ignore: "UnexpectedError",
  files: "test/fixtures/ossie/not-an-ontology.yaml",
}, { code: 0, stdoutIncludes: ["(ignored)"], stdoutExcludes: ["::error"] });

run("import with an unknown importer fails", {
  command: "import",
  importer: "xsd",
  files: "test/fixtures/ossie/person.ontology.yaml",
}, { code: 1, stdoutIncludes: ["Unknown importer", "ossie, owl"] });

run("import without an importer fails", {
  command: "import",
  files: "test/fixtures/ossie/person.ontology.yaml",
}, { code: 1, stdoutIncludes: ["Unknown importer", "(none)"] });

// --- OWL: the `owl` generator and importer ----------------------------------

run("generate owl writes Turtle (.owl.ttl)", {
  command: "generate",
  generator: "owl",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.owl.ttl")] });

run("owl writes descriptions as rdfs:comment by default", {
  command: "generate",
  generator: "owl",
  files: "test/fixtures/owl/described.yaml",
}, { code: 0, stdoutIncludes: ['rdfs:comment "Someone we know."'] });

run("format: nt switches owl to N-Triples (.owl.nt)", {
  command: "generate",
  generator: "owl",
  format: "nt",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.owl.nt")] });

run("metadata-profile: linkml writes descriptions as skos:definition", {
  command: "generate",
  generator: "owl",
  "metadata-profile": "linkml",
  files: "test/fixtures/owl/described.yaml",
}, { code: 0, stdoutIncludes: ['skos:definition "Someone we know."'], stdoutExcludes: ["rdfs:comment"] });

run("an unknown metadata-profile fails", {
  command: "generate",
  generator: "owl",
  "metadata-profile": "dublin-core",
  files: "examples/person.yaml",
}, { code: 1, stdoutIncludes: ["Unknown metadata-profile", "rdfs, linkml"] });

run("an unknown permissible-values fails", {
  command: "generate",
  generator: "owl",
  "permissible-values": "literal",
  files: "examples/person.yaml",
}, { code: 1, stdoutIncludes: ["Unknown permissible-values", "individual, class"] });

run("only-root-schema makes owl import the other schemas instead", {
  command: "generate",
  generator: "owl",
  "only-root-schema": "true",
  files: "test/fixtures/imports/main.yaml",
  imports: "test/fixtures/imports/common",
}, { code: 0, stdoutIncludes: ["owl:imports"] });

run("only-root-schema leaves imported classes out of shacl", {
  command: "generate",
  generator: "shacl",
  "only-root-schema": "true",
  files: "test/fixtures/imports/main.yaml",
  imports: "test/fixtures/imports/common",
}, { code: 0, stdoutIncludes: ["Employee"], stdoutExcludes: ["shared:Party"] });

run("import owl turns an ontology back into a LinkML schema", {
  command: "import",
  importer: "owl",
  files: "test/fixtures/owl/person.ttl",
  output: path.relative(ROOT, outDir),
}, {
  code: 0,
  outputsInclude: ["problems<<", "0"],
  filesExist: [path.join(path.relative(ROOT, outDir), "person.linkml.yaml")],
});

run("import owl can write the schema as JSON", {
  command: "import",
  importer: "owl",
  format: "json",
  files: "test/fixtures/owl/person.ttl",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.linkml.json")] });

// Turtle also reads N-Triples, so the way to see that `nt` reached the engine
// is that it no longer reads Turtle.
run("input-format: nt reads only N-Triples", {
  command: "import",
  importer: "owl",
  "input-format": "nt",
  files: "test/fixtures/owl/person.ttl",
}, { code: 1, stdoutIncludes: ["::error", "import failed"] });

run("input-format: nt accepts an N-Triples file", {
  command: "import",
  importer: "owl",
  "input-format": "nt",
  files: "test/fixtures/owl/person.nt",
}, { code: 0 });

run("an unknown input-format fails", {
  command: "import",
  importer: "owl",
  "input-format": "rdfxml",
  files: "test/fixtures/owl/person.ttl",
}, { code: 1, stdoutIncludes: ["Unknown input-format", "ttl, nt"] });

// `format` is the output of the importer, so an RDF syntax is not one of them.
run("an RDF format is rejected for import owl", {
  command: "import",
  importer: "owl",
  format: "ttl",
  files: "test/fixtures/owl/person.ttl",
}, { code: 1, stdoutIncludes: ["Unknown format", "yaml, json"] });

run("config changes how the ontology is mapped", {
  command: "import",
  importer: "owl",
  config: "test/fixtures/owl/config.yaml",
  files: "test/fixtures/owl/person.ttl",
}, { code: 0, stdoutIncludes: ["id: https://example.org/from-config"] });

run("schema-id sets the id of a schema imported from OWL", {
  command: "import",
  importer: "owl",
  "schema-id": "https://example.org/imported",
  files: "test/fixtures/owl/person.ttl",
}, { code: 0, stdoutIncludes: ["id: https://example.org/imported"] });

// As with the CLI's --schema-id, the input wins over the config, and the rest
// of the config still applies.
run("schema-id replaces the schema_id in config", {
  command: "import",
  importer: "owl",
  config: "test/fixtures/owl/config.yaml",
  "schema-id": "https://example.org/imported",
  files: "test/fixtures/owl/person.ttl",
}, {
  code: 0,
  stdoutIncludes: ["id: https://example.org/imported"],
  stdoutExcludes: ["from-config"],
});

run("a missing config file fails", {
  command: "import",
  importer: "owl",
  config: "test/fixtures/owl/no-such-config.yaml",
  files: "test/fixtures/owl/person.ttl",
}, { code: 1, stdoutIncludes: ["config file not found"] });

// The config maps the ontology's owl:imports to a LinkML schema, which the
// importer reads from `imports` to use its terms by name.
run("imports makes the schemas the config maps owl:imports to available", {
  command: "import",
  importer: "owl",
  "working-directory": "test/fixtures/imports",
  config: "../owl/imports-config.yaml",
  imports: "common",
  "list-not-imported": "true",
  files: "../owl/employee.ttl",
}, { code: 0, stdoutExcludes: ["could not be read"] });

run("list-not-imported reports a mapped import that is not there", {
  command: "import",
  importer: "owl",
  "working-directory": "test/fixtures/imports",
  config: "../owl/imports-config.yaml",
  "list-not-imported": "true",
  files: "../owl/employee.ttl",
}, { code: 0, stdoutIncludes: ["could not be read"] });

run("import owl rejects a document that is not Turtle", {
  command: "import",
  importer: "owl",
  files: "test/fixtures/owl/not-an-ontology.ttl",
}, { code: 1, stdoutIncludes: ["::error", "import failed"] });

// --- typescript, pydantic, er-diagram, translation ---------------------------

run("generate typescript writes a .ts file", {
  command: "generate",
  generator: "typescript",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.ts")] });

run("typescript include-null lets optional fields be null", {
  command: "generate",
  generator: "typescript",
  "include-null": "true",
  files: "examples/person.yaml",
}, { code: 0, stdoutIncludes: ["export interface Person", "age?: number | null"] });

run("generate pydantic writes a .py file", {
  command: "generate",
  generator: "pydantic",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.py")] });

run("generate er-diagram writes a Mermaid file (.mmd)", {
  command: "generate",
  generator: "er-diagram",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.mmd")] });

run("er-diagram marks optional attributes by default", {
  command: "generate",
  generator: "er-diagram",
  files: "examples/person.yaml",
}, { code: 0, stdoutIncludes: ["erDiagram", "integer? age"] });

run("optional-marker: false drops the marker for older Mermaid", {
  command: "generate",
  generator: "er-diagram",
  "optional-marker": "false",
  files: "examples/person.yaml",
}, { code: 0, stdoutIncludes: ["integer age"], stdoutExcludes: ["integer? age"] });

run("generate translation names the file after the target", {
  command: "generate",
  generator: "translation",
  target: "graphql",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.translation.graphql.json")] });

run("translation defaults to the base target", {
  command: "generate",
  generator: "translation",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.translation.base.json")] });

run("an unknown translation target fails", {
  command: "generate",
  generator: "translation",
  target: "protobuf",
  files: "examples/person.yaml",
}, { code: 1, stdoutIncludes: ["Unknown target", "base, uri"] });

run("derived-attributes adds inherited slots to classAttributes", {
  command: "generate",
  generator: "translation",
  "derived-attributes": "true",
  files: "test/fixtures/imports/main.yaml",
  imports: "test/fixtures/imports/common",
}, { code: 0, stdoutIncludes: ['"Employee": {', '"name": "name"'] });

// --- options passed to the generators that already existed ------------------

run("generate linkml can write JSON (.materialized.json)", {
  command: "generate",
  generator: "linkml",
  format: "json",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.materialized.json")] });

run("tree-root overrides the root of the JSON Schema", {
  command: "generate",
  generator: "json-schema",
  "tree-root": "Address",
  files: "examples/tables.yaml",
}, { code: 0, stdoutIncludes: ['"title": "Address"'] });

// Person references Address, not the other way round, so rooting the tree at
// Address prunes Person away.
run("graphql honours pruning-mode and tree-root", {
  command: "generate",
  generator: "graphql",
  "pruning-mode": "treeRoot",
  "tree-root": "Address",
  files: "examples/tables.yaml",
}, { code: 0, stdoutIncludes: ["type Address"], stdoutExcludes: ["type Person"] });

// --- import-map: where to load an import from, as in --import-map -----------

// model.yaml imports `units:core`, which only an import map can find.
const IMPORT_MAP = "test/fixtures/import-map";

run("an import with no import map entry cannot be resolved", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP,
}, { code: 1, stdoutIncludes: ["::error", "Could not read from the imports"] });

run("import-map with a prefix entry resolves a CURIE import", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP,
  "import-map": "prefix.json",
}, { code: 0, stdoutIncludes: ["✓ test/fixtures/import-map/model.yaml"], stdoutExcludes: ["::error"] });

run("import-map with an exact entry resolves a CURIE import", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP,
  "import-map": "exact.json",
}, { code: 0, stdoutIncludes: ["✓ test/fixtures/import-map/model.yaml"], stdoutExcludes: ["::error"] });

run("generate uses the import map too", {
  command: "generate",
  generator: "json-schema",
  files: "model.yaml",
  "working-directory": IMPORT_MAP,
  "import-map": "prefix.json",
  output: outDir,
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "model.schema.json")] });

run("a missing import-map file fails", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP,
  "import-map": "nope.json",
}, { code: 1, stdoutIncludes: ["import-map file not found"] });

run("an import-map that isn't JSON fails", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP,
  "import-map": "broken.json",
}, { code: 1, stdoutIncludes: ["is not valid JSON"] });

run("an import-map whose locations aren't strings fails", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP,
  "import-map": "not-strings.json",
}, { code: 1, stdoutIncludes: ["must be a JSON object from an import"] });

run("an import-map with a CURIE key is rejected by the engine", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP,
  "import-map": "curie-key.json",
}, { code: 1, stdoutIncludes: ["::error", "is a CURIE"] });

// A prefix entry whose location is working-directory itself: `./` and an empty
// location both load `units:core` from core.yaml next to model.yaml.
const IMPORT_MAP_HERE = "test/fixtures/import-map-here";

run("import-map with a './' prefix location loads from working-directory", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP_HERE,
  "import-map": "dot-slash.json",
}, { code: 0, stdoutIncludes: ["✓ test/fixtures/import-map-here/model.yaml"], stdoutExcludes: ["::error"] });

run("import-map with an empty prefix location loads from working-directory", {
  command: "validate",
  files: "model.yaml",
  "working-directory": IMPORT_MAP_HERE,
  "import-map": "empty.json",
}, { code: 0, stdoutIncludes: ["✓ test/fixtures/import-map-here/model.yaml"], stdoutExcludes: ["::error"] });

rmSync(outDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed.` : "\nAll tests passed.");
process.exit(failures ? 1 : 0);
