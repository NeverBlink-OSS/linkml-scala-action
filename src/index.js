import { LinkML } from "@neverblink/linkml";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveFiles } from "./glob.js";

// Kept in sync with the bundled @neverblink/linkml dependency (see package.json).
const LINKML_VERSION = "0.15.0";

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
// `props` holds the optional annotation properties (file, line, col, …).
// Entries without a value are dropped, so we never emit `line=undefined`.
function annotate(level, message, props = {}) {
  if (!annotationsOn) return;
  const s = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${escProp(v)}`)
    .join(",");
  process.stdout.write(`::${level}${s ? " " + s : ""}::${escData(message)}\n`);
}
const info = (m) => process.stdout.write(m + "\n");
function fail(message) {
  annotate("error", message);
  process.exitCode = 1;
}

// Accepted values for the inputs that are passed straight through to the
// engine. Checked up front so a typo is a clear action error rather than an
// opaque failure from inside linkml-scala.
const RDF_FORMATS = ["ttl", "nt"];
// Keyed by the lowercased input, valued by the spelling linkml-scala expects.
const PRUNING_MODES = { treeroot: "treeRoot", schema: "schema", skip: "skip" };

// ---------------------------------------------------------------------------
// Generator registry: how each generator turns a loaded SchemaView into output,
// and where that output goes. `multi` returns a { filename: contents } map.
// ---------------------------------------------------------------------------
function buildGenerators({
  open,
  packageName,
  format,
  pruningMode,
  treeRoot,
  skipClassesWithoutIdentifier,
}) {
  return {
    "json-schema": {
      ext: ".schema.json",
      run: (v) => LinkML.jsonSchema(v, open),
    },
    shacl: {
      ext: `.shacl.${format}`,
      run: (v) => LinkML.shacl(v, open, false, format),
    },
    rdfs: {
      ext: `.rdfs.${format}`,
      run: (v) => LinkML.rdfs(v, false, format),
    },
    linkml: {
      ext: ".materialized.yaml",
      run: (v) => LinkML.linkml(v),
    },
    frictionless: {
      multi: true,
      run: (v) =>
        LinkML.frictionless(
          v,
          pruningMode,
          treeRoot || undefined,
          skipClassesWithoutIdentifier
        ),
    },
    graphql: {
      ext: ".graphql",
      run: (v) => LinkML.graphQl(v),
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
// Problems are structured `SchemaIssue` objects (see linkml-scala's
// model/validation-report.yaml), each with a severity of:
//   FATAL   – the schema could not be loaded, so nothing can be generated
//   ERROR   – the schema loaded but is invalid (e.g. non-unique names)
//   WARNING – advisory (e.g. no `tree_root` class)
// FATAL/ERROR fail the run; WARNING only does so under `strict`.
// ---------------------------------------------------------------------------
const isWarning = (issue) =>
  String(issue.severity ?? "").toUpperCase() === "WARNING";

// Human-readable text for an issue: `details` when the engine inferred it (the
// longer form, which normally embeds the short message), else `message`. Both
// are filled in because linkml-scala's `inferMessages` defaults to true; the
// fallback only matters for an issue type that ships without either.
function issueText(issue) {
  const body = issue.details || issue.message;
  const pointer = issue.location?.json_pointer;
  // The issue type is what `ignore` matches on, so print it alongside the
  // problem – otherwise there is no way to find out what to write there.
  const type = issue.issue_type ? ` [${issue.issue_type}]` : "";
  if (!body) {
    return `${issue.severity ?? "ERROR"} problem${pointer ? ` at ${pointer}` : ""}${type}`;
  }
  // The inferred text usually already ends with "at <pointer>"; only append the
  // pointer when it doesn't, so it isn't printed twice.
  const withPointer =
    pointer && !body.includes(pointer) ? `${body} at ${pointer}` : body;
  return `${withPointer}${type}`;
}

// GitHub annotation position for an issue, when the engine pinned down a code
// region (it does for parse errors; reference errors carry only a JSON
// pointer). linkml-scala's `end_column` is exclusive, GitHub's is inclusive.
function position(issue) {
  const r = issue.location?.code_region;
  if (!r?.start_line) return {};
  const pos = { line: r.start_line, col: r.start_column };
  if (r.end_line || r.end_column) {
    pos.endLine = r.end_line ?? r.start_line;
    if (r.end_column > 1) pos.endColumn = r.end_column - 1;
  }
  return pos;
}

// A bare class name, which is what a type designator holds.
const ISSUE_TYPE_RE = /^[A-Za-z][A-Za-z0-9]*$/;

// `ignore` names issue types to silence. The engine tags every problem with its
// class from the validation-report model in `issue_type` (the model's type
// designator) – `NoTreeRootClass`, `UnknownReference`, and so on – and that is
// what an entry has to be. A matching problem is silenced (not annotated, not
// counted, no effect on the exit code) but still logged, so it stays auditable.
// Returns null when an entry isn't a class name, which is almost always a
// message substring left over from how `ignore` used to work; silently
// matching nothing would be worse than saying so.
function parseIgnore() {
  const entries = getInput("ignore")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = entries.filter((e) => !ISSUE_TYPE_RE.test(e));
  if (bad.length) {
    fail(
      `Not an issue type: ${bad.map((e) => `'${e}'`).join(", ")}. ` +
        "`ignore` takes the issue type names shown in square brackets on each " +
        "reported problem (e.g. NoTreeRootClass), not message text."
    );
    return null;
  }
  return entries.map((e) => e.toLowerCase());
}

// Exact match, not substring: `InvalidRange` must not silence
// `InvalidDefaultRange`.
const isIgnored = (issue, ignore) =>
  ignore.includes(String(issue.issue_type ?? "").toLowerCase());

// ---------------------------------------------------------------------------
// Load a schema. Loading is validating: linkml-scala lints on the way through,
// so the report covers warnings and errors and not just the fatals that blocked
// loading, and `view` is absent exactly when a fatal problem stopped the load.
// Schema problems (including unparseable YAML and unresolvable imports) come
// back in the report rather than as exceptions, so a throw here is unexpected —
// surface it as a synthetic fatal issue, which keeps it annotated, counted and
// silenceable like any other problem.
// ---------------------------------------------------------------------------
function loadSchema(file, pool, baseDir) {
  try {
    const { view, report } = LinkML.loadFromPath(keyFor(baseDir, file), pool);
    return { view, issues: report?.issues ?? [] };
  } catch (e) {
    return {
      view: undefined,
      issues: [
        { issue_type: "UnexpectedError", severity: "FATAL", message: errMessage(e) },
      ],
    };
  }
}

// Annotate every issue not silenced by `ignore`. Returns how many were kept and
// whether they should fail the run.
function reportIssues(issues, rel, strict, ignore) {
  let kept = 0;
  let failed = false;
  for (const issue of issues) {
    const text = issueText(issue);
    if (isIgnored(issue, ignore)) {
      info(`  (ignored) ${text}`);
      continue;
    }
    kept++;
    const warning = isWarning(issue);
    annotate(warning ? "warning" : "error", text, {
      file: rel,
      ...position(issue),
    });
    if (!warning || strict) failed = true;
  }
  return { kept, failed };
}

// ---------------------------------------------------------------------------
function runValidate(files, pool, baseDir, strict, ignore) {
  let problems = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    const { view, issues } = loadSchema(file, pool, baseDir);
    const { kept, failed } = reportIssues(issues, rel, strict, ignore);

    problems += kept;
    if (failed) process.exitCode = 1;

    if (!view && kept > 0) fail(`${rel}: fatal validation problems`);
    else if (kept === 0) info(`✓ ${rel}`);
    else info(`${failed ? "✗" : "•"} ${rel}`);
  }
  return problems;
}

function writeAt(dest, contents) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
  info(`  → ${path.relative(process.cwd(), dest)}`);
}

function writeSingle(outDir, file, contents, ext) {
  const base = path.basename(file).replace(/\.ya?ml$/i, "");
  writeAt(path.join(outDir, base + ext), contents);
}

function runGenerate(files, pool, baseDir, gen, genName, outDir, strict, ignore) {
  let problems = 0;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    const { view, issues } = loadSchema(file, pool, baseDir);
    const { kept, failed } = reportIssues(issues, rel, strict, ignore);

    problems += kept;
    if (failed) process.exitCode = 1;

    // Without a view a fatal problem stopped the load, so there is nothing to
    // generate from. Non-fatal problems don't block generation: the output is
    // still written (and still fails the run, unless it was only a warning) so
    // it's there to inspect.
    if (!view) {
      if (kept === 0) {
        // Every problem was silenced — nothing to fail on, but note that no
        // output was produced for this schema.
        info(`✓ ${rel} (problems ignored; no output generated)`);
      } else {
        fail(`${rel}: ${genName} generation failed`);
      }
      continue;
    }

    let result;
    try {
      result = gen.run(view);
    } catch (e) {
      const issue = {
        issue_type: "UnexpectedError",
        severity: "FATAL",
        message: errMessage(e),
      };
      if (isIgnored(issue, ignore)) {
        info(`  (ignored) ${issue.message}`);
        info(`✓ ${rel} (problems ignored; no output generated)`);
        continue;
      }
      problems++;
      annotate("error", issueText(issue), { file: rel });
      fail(`${rel}: ${genName} generation failed`);
      continue;
    }

    info(`${failed ? "✗" : "✓"} ${rel}`);
    if (gen.multi) {
      // { filename: contents } – write under <outDir>/<schema>/<filename>. A
      // name may itself contain directories (frictionless emits
      // `schemas/<table>.json`), so keep it as-is rather than flattening it.
      const base = path.basename(file).replace(/\.ya?ml$/i, "");
      for (const [name, contents] of Object.entries(result)) {
        if (outDir) writeAt(path.join(outDir, base, name), contents);
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
  if (ignore === null) return;
  const strict = getBool("strict");

  let problems = 0;
  if (command === "validate") {
    problems = runValidate(files, pool, baseDir, strict, ignore);
  } else if (command === "generate") {
    const genName = getInput("generator").toLowerCase();
    const format = getInput("format", "ttl").toLowerCase() || "ttl";
    if (!RDF_FORMATS.includes(format)) {
      fail(`Unknown format '${format}'. Expected one of: ${RDF_FORMATS.join(", ")}.`);
      return;
    }
    const modeInput = getInput("pruning-mode", "skip").toLowerCase() || "skip";
    if (!Object.hasOwn(PRUNING_MODES, modeInput)) {
      fail(
        `Unknown pruning-mode '${modeInput}'. Expected one of: ${Object.values(
          PRUNING_MODES
        ).join(", ")}.`
      );
      return;
    }
    const pruningMode = PRUNING_MODES[modeInput];
    const generators = buildGenerators({
      open: getBool("open"),
      packageName: getInput("package", "linkml"),
      format,
      pruningMode,
      treeRoot: getInput("tree-root"),
      skipClassesWithoutIdentifier: getBool("skip-classes-without-identifier"),
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
    problems = runGenerate(
      files,
      pool,
      baseDir,
      gen,
      genName,
      outDir,
      strict,
      ignore
    );
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
