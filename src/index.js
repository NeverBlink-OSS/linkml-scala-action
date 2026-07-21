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

// ---------------------------------------------------------------------------
function runValidate(files, pool, baseDir, strict) {
  let problems = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let report;
    try {
      // Fatal problems are thrown while resolving the schema; warnings come
      // back as a string from lint().
      const view = LinkML.loadFromPath(keyFor(baseDir, file), pool);
      report = LinkML.lint(view);
    } catch (e) {
      problems++;
      for (const line of errMessage(e).split("\n")) {
        if (line.trim()) annotate("error", line.trim(), rel);
      }
      fail(`${rel}: fatal validation problems`);
      continue;
    }
    if (!report) {
      info(`✓ ${rel}`);
      continue;
    }
    for (const raw of report.split("\n")) {
      const line = raw.trim();
      if (!line || /^Found \d+ problem/i.test(line)) continue;
      problems++;
      const isWarning = /^warning/i.test(line);
      if (isWarning) {
        annotate("warning", line, rel);
        if (strict) process.exitCode = 1;
      } else {
        annotate("error", line, rel);
        process.exitCode = 1;
      }
    }
    info(`${strict ? "✗" : "•"} ${rel}`);
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

function runGenerate(files, pool, baseDir, gen, genName, outDir) {
  let problems = 0;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let result;
    try {
      const view = LinkML.loadFromPath(keyFor(baseDir, file), pool);
      result = gen.run(view);
    } catch (e) {
      problems++;
      annotate("error", errMessage(e), rel);
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

  let problems = 0;
  if (command === "validate") {
    problems = runValidate(files, pool, baseDir, getBool("strict"));
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
    problems = runGenerate(files, pool, baseDir, gen, genName, outDir);
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
