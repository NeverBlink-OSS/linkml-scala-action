import { LinkML } from "@neverblink/linkml";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveFiles } from "./glob.js";

// Kept in sync with the bundled @neverblink/linkml dependency (see package.json).
const LINKML_VERSION = "0.9.3";

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
// Generator registry: how each generator is invoked and where its output goes.
// `single` returns a string; `multi` returns a { filename: contents } map.
// ---------------------------------------------------------------------------
function buildGenerators({ open, packageName }) {
  return {
    "json-schema": {
      ext: ".schema.json",
      run: (s, m) => LinkML.jsonSchema(s, m, open),
    },
    shacl: {
      ext: ".shacl.nt",
      run: (s, m) => LinkML.shacl(s, m, open),
    },
    rdfs: {
      ext: ".rdfs.nt",
      run: (s, m) => LinkML.rdfs(s, m, false),
    },
    linkml: {
      ext: ".materialized.yaml",
      run: (s, m) => LinkML.linkml(s, m),
    },
    "table-schema": {
      ext: ".table.json",
      run: (s, m) => LinkML.tableSchema(s, m),
    },
    scala: {
      multi: true,
      run: (s, m) => LinkML.scala(s, m, packageName),
    },
  };
}

// ---------------------------------------------------------------------------
// Load the import map: every *.yaml/*.yml under `imports`, keyed by basename.
// linkml resolves `imports: [shared]` to the map key `shared.yaml`.
// ---------------------------------------------------------------------------
function loadImportMap(importsDir) {
  const map = {};
  if (!importsDir) return map;
  if (!fs.existsSync(importsDir)) {
    fail(`imports directory not found: ${importsDir}`);
    return map;
  }
  for (const name of fs.readdirSync(importsDir)) {
    if (/\.ya?ml$/i.test(name)) {
      map[name] = fs.readFileSync(path.join(importsDir, name), "utf8");
    }
  }
  return map;
}

// Extract the human-readable message from a thrown Scala.js error.
const errMessage = (e) =>
  (e && e.message ? String(e.message) : String(e)).replace(
    /^java\.lang\.\w+(?:Exception)?:\s*/,
    ""
  );

// ---------------------------------------------------------------------------
function runValidate(files, importMap, strict) {
  let problems = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let report;
    try {
      report = LinkML.lint(fs.readFileSync(file, "utf8"), importMap);
    } catch (e) {
      // Fatal problems are thrown rather than returned.
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

function runGenerate(files, importMap, gen, genName, outDir) {
  let problems = 0;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let result;
    try {
      result = gen.run(fs.readFileSync(file, "utf8"), importMap);
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

  const importMap = loadImportMap(
    getInput("imports") ? path.resolve(baseDir, getInput("imports")) : ""
  );

  let problems = 0;
  if (command === "validate") {
    problems = runValidate(files, importMap, getBool("strict"));
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
    problems = runGenerate(files, importMap, gen, genName, outDir);
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
