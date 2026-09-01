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
  stdoutIncludes: ["::error", "Cannot import schema", "Could not read from import map"],
});

run("generate on an unresolvable import fails without output", {
  command: "generate",
  generator: "json-schema",
  files: "test/fixtures/errors/missing-import.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 1, stdoutIncludes: ["::error", "generation failed"] });

rmSync(outDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed.` : "\nAll tests passed.");
process.exit(failures ? 1 : 0);
