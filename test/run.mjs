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

run("generate shacl to log", {
  command: "generate",
  generator: "shacl",
  files: "examples/person.yaml",
}, { code: 0, stdoutIncludes: ["shacl"] });

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

run("generate rdfs writes N-Triples (.rdfs.nt)", {
  command: "generate",
  generator: "rdfs",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person.rdfs.nt")] });

run("generate scala writes multiple files under <schema>/", {
  command: "generate",
  generator: "scala",
  package: "com.example",
  files: "examples/person.yaml",
  output: path.relative(ROOT, outDir),
}, { code: 0, filesExist: [path.join(path.relative(ROOT, outDir), "person", "Person.scala")] });

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

rmSync(outDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed.` : "\nAll tests passed.");
process.exit(failures ? 1 : 0);
