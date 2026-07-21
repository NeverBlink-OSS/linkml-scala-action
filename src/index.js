import { LinkML } from "@neverblink/linkml";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveFiles } from "./glob.js";

// Kept in sync with the bundled @neverblink/linkml dependency (see package.json).
const LINKML_VERSION = "0.10.0";

// ---------------------------------------------------------------------------
// Minimal GitHub Actions runtime helpers (no @actions/core dependency).
// ---------------------------------------------------------------------------
function getInput(name, def = "") {
  const key = "INPUT_" + name.toUpperCase().replace(/ /g, "_");
  const v = process.env[key];
  return v === undefined ? def : v.trim();
}
const getBool = (name, def = false) => {
  const v = getInput(name);
  return v === "" ? def : /^(true|1|yes|on)$/i.test(v);
};
function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) fs.appendFileSync(f, `${name}<<_EOF_\n${value}\n_EOF_\n`);
}
const escData = (s) =>
  String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) =>
  escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

let annotationsOn = true;
function annotate(level, message, file) {
  if (!annotationsOn) return;
  const loc = file ? ` file=${escProp(file)}` : "";
  process.stdout.write(`::${level}${loc}::${escData(message)}\n`);
}
const info = (m) => process.stdout.write(m + "\n");
function fail(message) {
  annotate("error", message);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Generator registry: how each generator turns a loaded SchemaView into output,
// and where that output goes. `multi` returns a { filename: contents } map.
// ---------------------------------------------------------------------------
function buildGenerators({ open, packageName }) {
  return {
    "json-schema": {
      ext: ".schema.json",
      run: (v) => LinkML.jsonSchema(v, open),
    },
    shacl: {
      ext: ".shacl.nt",
      run: (v) => LinkML.shacl(v, open),
    },
    rdfs: {
      ext: ".rdfs.nt",
      run: (v) => LinkML.rdfs(v, false),
    },
    linkml: {
      ext: ".materialized.yaml",
      run: (v) => LinkML.linkml(v),
    },
    "table-schema": {
      ext: ".table.json",
      run: (v) => LinkML.tableSchema(v),
    },
    scala: {
      multi: true,
      run: (v) => LinkML.scala(v, packageName),
    },
  };
}

// Import-map key for a file: its path relative to the base directory, in POSIX
// form. linkml-scala resolves `imports:` entries as paths relative to the
// importing schema's directory, so keys must be paths-as-seen-from-the-root.
const keyFor = (baseDir, file) =>
  path.relative(baseDir, file).split(path.sep).join("/");

// Recursively collect *.yaml/*.yml files under a directory (absolute paths).
function collectYaml(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectYaml(abs));
    else if (e.isFile() && /\.ya?ml$/i.test(e.name)) out.push(abs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build the import map (pool): every input schema plus every schema under the
// `imports` directory, keyed by path relative to `baseDir`. Each root schema is
// then loaded via loadFromPath(key, pool), which resolves imports through this
// map and stays correct even when the root takes part in an import cycle.
// ---------------------------------------------------------------------------
function buildImportMap(baseDir, files, importsDir) {
  const pool = {};
  for (const f of files) pool[keyFor(baseDir, f)] = fs.readFileSync(f, "utf8");
  if (importsDir) {
    if (!fs.existsSync(importsDir)) {
      fail(`imports directory not found: ${importsDir}`);
    } else {
      for (const f of collectYaml(importsDir)) {
        pool[keyFor(baseDir, f)] = fs.readFileSync(f, "utf8");
      }
    }
  }
  return pool;
}

// Extract the human-readable message from a thrown Scala.js error.
const errMessage = (e) =>
  (e && e.message ? String(e.message) : String(e)).replace(
    /^java\.lang\.\w+(?:Exception)?:\s*/,
    ""
  );

// Parse the `ignore` input into lower-cased substrings, one per line. A problem
// whose message contains any of these is silenced (not annotated, not counted,
// no effect on the exit code) — but still logged, so it stays auditable.
function parseIgnore() {
  return getInput("ignore")
    .split("\n")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const isIgnored = (line, ignore) =>
  ignore.some((p) => line.toLowerCase().includes(p));

// Problem message lines from a lint report or a thrown error, minus the
// summary/header line.
function problemLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^Found \d+ problem/i.test(l) &&
        !/^Fatal validation problems/i.test(l)
    );
}

// ---------------------------------------------------------------------------
function runValidate(files, pool, baseDir, strict, ignore) {
  let problems = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let lines;
    let fatal = false;
    try {
      // Fatal problems are thrown while resolving the schema; warnings come
      // back as a string from lint().
      const view = LinkML.loadFromPath(keyFor(baseDir, file), pool);
      const report = LinkML.lint(view);
      lines = report ? problemLines(report) : [];
    } catch (e) {
      fatal = true;
      lines = problemLines(errMessage(e));
    }

    let kept = 0;
    for (const line of lines) {
      if (isIgnored(line, ignore)) {
        info(`  (ignored) ${line}`);
        continue;
      }
      kept++;
      problems++;
      if (!fatal && /^warning/i.test(line)) {
        annotate("warning", line, rel);
        if (strict) process.exitCode = 1;
      } else {
        annotate("error", line, rel);
        process.exitCode = 1;
      }
    }

    if (fatal && kept > 0) fail(`${rel}: fatal validation problems`);
    else if (kept === 0) info(`✓ ${rel}`);
    else info(`${strict ? "✗" : "•"} ${rel}`);
  }
  return problems;
}

function writeSingle(outDir, file, contents, ext) {
  const base = path.basename(file).replace(/\.ya?ml$/i, "");
  const dest = path.join(outDir, base + ext);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
  info(`  → ${path.relative(process.cwd(), dest)}`);
}

function runGenerate(files, pool, baseDir, gen, genName, outDir, ignore) {
  let problems = 0;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let result;
    try {
      const view = LinkML.loadFromPath(keyFor(baseDir, file), pool);
      result = gen.run(view);
    } catch (e) {
      const kept = [];
      for (const line of problemLines(errMessage(e))) {
        if (isIgnored(line, ignore)) info(`  (ignored) ${line}`);
        else kept.push(line);
      }
      if (kept.length === 0) {
        // Every problem was silenced — nothing to fail on, but note that no
        // output was produced for this schema.
        info(`✓ ${rel} (problems ignored; no output generated)`);
        continue;
      }
      problems++;
      for (const line of kept) annotate("error", line, rel);
      fail(`${rel}: ${genName} generation failed`);
      continue;
    }
    info(`✓ ${rel}`);
    if (gen.multi) {
      // { filename: contents } – write under <outDir>/<schema>/<filename>.
      const base = path.basename(file).replace(/\.ya?ml$/i, "");
      for (const [name, contents] of Object.entries(result)) {
        if (outDir) writeSingle(path.join(outDir, base), name, contents, "");
        else info(`----- ${name} -----\n${contents}`);
      }
    } else if (outDir) {
      writeSingle(outDir, file, result, gen.ext);
    } else {
      info(`----- ${rel} → ${genName} -----\n${result}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
function main() {
  annotationsOn = getBool("annotations", true);
  const command = getInput("command", "validate").toLowerCase();
  const baseDir = path.resolve(process.cwd(), getInput("working-directory", "."));
  const filesSpec = getInput("files");

  setOutput("linkml-version", LINKML_VERSION);

  if (!filesSpec) {
    fail("No `files` provided.");
    return;
  }

  const files = resolveFiles(filesSpec, baseDir).filter((f) => {
    const ok = fs.existsSync(f);
    if (!ok) annotate("warning", `No such file: ${path.relative(process.cwd(), f)}`);
    return ok;
  });

  setOutput("files", String(files.length));

  if (files.length === 0) {
    fail(`No schema files matched: ${filesSpec}`);
    return;
  }

  const pool = buildImportMap(
    baseDir,
    files,
    getInput("imports") ? path.resolve(baseDir, getInput("imports")) : ""
  );
  const ignore = parseIgnore();

  let problems = 0;
  if (command === "validate") {
    problems = runValidate(files, pool, baseDir, getBool("strict"), ignore);
  } else if (command === "generate") {
    const genName = getInput("generator").toLowerCase();
    const generators = buildGenerators({
      open: getBool("open"),
      packageName: getInput("package", "linkml"),
    });
    const gen = generators[genName];
    if (!gen) {
      fail(
        `Unknown generator '${genName || "(none)"}'. Expected one of: ${Object.keys(
          generators
        ).join(", ")}.`
      );
      return;
    }
    const outDir = getInput("output")
      ? path.resolve(baseDir, getInput("output"))
      : "";
    problems = runGenerate(files, pool, baseDir, gen, genName, outDir, ignore);
  } else {
    fail(`Unknown command '${command}'. Expected 'validate' or 'generate'.`);
    return;
  }

  setOutput("problems", String(problems));
  info(
    `\nlinkml-scala ${LINKML_VERSION}: ${command} on ${files.length} file(s), ${problems} problem(s).`
  );
}

try {
  main();
} catch (e) {
  fail(`Unexpected error: ${errMessage(e)}`);
}
