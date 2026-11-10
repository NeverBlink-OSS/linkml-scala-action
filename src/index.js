import { LinkML } from "@neverblink/linkml";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveFiles } from "./glob.js";

// Kept in sync with the bundled @neverblink/linkml dependency (see package.json).
const LINKML_VERSION = "0.18.2";

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
//
// `format` means different things to different generators, so it is keyed by
// the generator (or importer) name, with the default first. A name that isn't
// listed here takes no format at all and ignores the input. Generators and
// importers have separate tables because `owl` is both, and writes RDF one way
// and a LinkML schema the other.
const GENERATOR_FORMATS = {
  shacl: ["ttl", "nt"],
  rdfs: ["ttl", "nt"],
  owl: ["ttl", "nt"],
  linkml: ["yaml", "json"],
  ossie: ["yaml", "json"],
};
const IMPORTER_FORMATS = {
  ossie: ["yaml", "json"],
  owl: ["yaml", "json"],
};
// `error-handling` is per-generator too: the Scala and TypeScript generators
// report a function's errors in different ways.
const ERROR_HANDLING = {
  scala: ["annotation", "either"],
  typescript: ["exception", "result"],
};
// Keyed by the lowercased input, valued by the spelling linkml-scala expects.
// `treeRoot` is how linkml-scala spelled it before 0.18, so it is still taken.
const PRUNING_MODES = {
  tree_root: "tree_root",
  "tree-root": "tree_root",
  treeroot: "tree_root",
  schema: "schema",
  skip: "skip",
};
// Inputs with a fixed set of values. Unlike `format`, each one means the same
// thing wherever it applies.
const CHOICES = {
  "metadata-profile": ["rdfs", "linkml"],
  "permissible-values": ["individual", "class"],
  target: [
    "base",
    "uri",
    "scala",
    "graphql",
    "frictionless",
    "ossie",
    "erdiagram",
    "json",
    "typescript",
    "pydantic",
    "docs",
  ],
  "input-format": ["ttl", "nt"],
  "tree-root-inline-type": ["plain", "optional", "list", "compact_dict", "simple_dict"],
};

// Resolve one of the CHOICES inputs: undefined when blank, so the engine's own
// default applies, and null (after failing the run) when the value isn't one
// of the accepted ones.
function resolveChoice(name) {
  const value = getInput(name).toLowerCase();
  if (!value) return undefined;
  const allowed = CHOICES[name];
  if (!allowed.includes(value)) {
    fail(`Unknown ${name} '${value}'. Expected one of: ${allowed.join(", ")}.`);
    return null;
  }
  return value;
}

// Resolve a whole number input: undefined when blank, null (after failing the
// run) when it isn't one.
function resolveCount(name) {
  const value = getInput(name);
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    fail(`${name} must be a whole number, got '${value}'.`);
    return null;
  }
  return Number(value);
}

// Resolve a per-generator (or per-importer) input such as `format`: the first
// value in `table` when the input is blank, "" when the generator doesn't take
// it, and null (after failing the run) when the value isn't one it accepts.
function resolveFor(table, name, inputName) {
  const allowed = table[name];
  if (!allowed) return "";
  const value = getInput(inputName).toLowerCase() || allowed[0];
  if (!allowed.includes(value)) {
    fail(
      `Unknown ${inputName} '${value}' for '${name}'. Expected one of: ${allowed.join(", ")}.`
    );
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Generator registry: how each generator turns a loaded SchemaView into output,
// and where that output goes. `multi` returns a { filename: contents } map.
// Each generator is a method of the view taking one options object. An option
// left undefined gets the engine's default (they differ between generators);
// the engine rejects keys it doesn't know, so each generator gets only its own.
// ---------------------------------------------------------------------------
function buildGenerators(o) {
  const pruning = { pruning_mode: o.pruningMode, tree_root: o.treeRoot };
  const lang = { metadata_language: o.metadataLanguage };
  return {
    "json-schema": {
      ext: ".schema.json",
      run: (v) =>
        v.jsonSchema({
          open: o.open,
          tree_root: o.treeRoot,
          include_null: o.includeNull,
          tree_root_inline_type: o.treeRootInlineType,
          indentation_step: o.indentationStep,
          ...lang,
        }),
    },
    shacl: {
      ext: `.shacl.${o.format}`,
      run: (v) =>
        v.shacl({
          open: o.open,
          only_classes_from_root_schema: o.onlyRootSchema,
          format: o.format,
        }),
    },
    rdfs: {
      ext: `.rdfs.${o.format}`,
      run: (v) =>
        v.rdfs({ only_classes_from_root_schema: o.onlyRootSchema, format: o.format }),
    },
    owl: {
      ext: `.owl.${o.format}`,
      run: (v) =>
        v.owl({
          only_root_schema: o.onlyRootSchema,
          metadata_profile: o.metadataProfile,
          permissible_values: o.permissibleValues,
          format: o.format,
        }),
    },
    linkml: {
      ext: `.materialized.${o.format}`,
      run: (v) =>
        v.linkml({
          ...pruning,
          skip_class_derivation: o.skipDerivation,
          format: o.format,
          full_uris: o.fullUris,
        }),
    },
    frictionless: {
      multi: true,
      run: (v) =>
        v.frictionless({
          ...pruning,
          skip_classes_without_identifier: o.skipClassesWithoutIdentifier,
          ...lang,
        }),
    },
    graphql: {
      ext: ".graphql",
      run: (v) => v.graphql({ ...pruning, ...lang }),
    },
    typescript: {
      ext: ".ts",
      run: (v) =>
        v.typescript({
          ...pruning,
          include_null: o.includeNull,
          open: o.open,
          optional_defaults: o.optionalDefaults,
          error_handling: o.errorHandling,
          ...lang,
        }),
    },
    pydantic: {
      ext: ".py",
      run: (v) =>
        v.pydantic({ ...pruning, include_null: o.includeNull, open: o.open, ...lang }),
    },
    "er-diagram": {
      ext: ".mmd",
      run: (v) => v.erDiagram({ ...pruning, optional_marker: o.optionalMarker }),
    },
    // The target is part of the name, so several targets can share an output
    // directory.
    translation: {
      ext: `.translation.${o.target ?? "base"}.json`,
      run: (v) =>
        v.translation({
          target: o.target,
          derived_attributes: o.derivedAttributes,
          indentation_step: o.indentationStep,
        }),
    },
    // A page per element, or a single `docs.md` with `single-file`.
    docs: {
      multi: true,
      run: (v) => v.docs({ ...pruning, single_file: o.singleFile, ...lang }),
    },
    // The engine returns the statistics as an object.
    stats: {
      ext: ".stats.json",
      run: (v) => JSON.stringify(v.stats({ ...pruning }), null, 2),
    },
    ossie: {
      ext: `.ossie.${o.format}`,
      run: (v) => v.ossie({ ...pruning, format: o.format, ...lang }),
    },
    scala: {
      multi: true,
      run: (v) =>
        v.scala({
          package: o.packageName,
          error_handling: o.errorHandling,
          generate_emit_prefixes: o.generateEmitPrefixes,
          skip_leaf_interfaces: o.skipLeafInterfaces,
          ...lang,
        }),
    },
  };
}

// ---------------------------------------------------------------------------
// Importer registry: the other direction – read a document in some other format
// and produce the LinkML schema it describes (the CLI's `from <name>`). The
// input is not a LinkML schema, so it is passed through as text rather than
// loaded into a SchemaView. Both return `{ schema, warnings }`, the warnings
// listing what could not be imported.
// ---------------------------------------------------------------------------
function buildImporters({
  schemaId,
  format,
  fullUris,
  owlConfig,
  importMap,
  inputFormat,
}) {
  const output = { schema_id: schemaId || undefined, format, full_uris: fullUris };
  return {
    ossie: {
      ext: `.linkml.${format}`,
      run: (text) => LinkML.fromOssie(text, output),
    },
    owl: {
      ext: `.linkml.${format}`,
      run: (text) =>
        LinkML.fromOwl(text, {
          ...output,
          config: owlConfig,
          input_format: inputFormat,
          schemas: importMap,
        }),
    },
  };
}

// Read the OWL import config: a YAML (or JSON, which is YAML too) file that the
// engine takes as an object. Returns undefined when there is none, and null
// (after failing the run) when it is missing or isn't a mapping. Checking the
// fields is left to the engine, which names a field it doesn't know.
function readOwlConfig(baseDir) {
  const input = getInput("config");
  if (!input) return undefined;
  const file = path.resolve(baseDir, input);
  const rel = path.relative(process.cwd(), file);
  if (!fs.existsSync(file)) {
    fail(`config file not found: ${rel}`);
    return null;
  }
  let config;
  try {
    config = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`config ${rel} is not valid YAML or JSON: ${errMessage(e)}`);
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail(`config ${rel} must be a mapping of settings, e.g. 'schema_id: https://…'.`);
    return null;
  }
  return config;
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
// `extraPaths` are the local locations of the `import-map` (absolute paths):
// a directory adds every schema under it, a file adds that file. A location
// that doesn't exist is skipped, and the engine reports the import it was for.
function buildImportMap(baseDir, files, importsDir, extraPaths = []) {
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
  for (const p of extraPaths) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      for (const f of collectYaml(p)) {
        pool[keyFor(baseDir, f)] = fs.readFileSync(f, "utf8");
      }
      continue;
    }
    // The engine ignores a `.yaml`/`.yml` extension, so a location may leave
    // it out.
    const f = [p, `${p}.yaml`, `${p}.yml`].find(
      (c) => fs.existsSync(c) && fs.statSync(c).isFile()
    );
    if (f) pool[keyFor(baseDir, f)] = fs.readFileSync(f, "utf8");
  }
  return pool;
}

// A location with a URI scheme (`https://…`, `urn:…`). A Windows drive letter
// (`C:\…`) is a single letter followed by a colon, so it stays a local path.
const isUri = (s) => /^[a-z][a-z0-9+.-]+:/i.test(s);

// ---------------------------------------------------------------------------
// Read the `import-map` input: a JSON file in the format of linkml-scala's
// `--import-map` (and LinkML-Python's `--importmap`), from an import to the
// location to load it from. The JS loader looks locations up in the pool, so
// each local location is turned into a pool key (relative to `baseDir`, as the
// CLI takes them relative to the current directory), and returned in `paths`
// so it can be read into the pool. Returns undefined when the input is blank,
// and null (after failing the run) when the file is missing or malformed.
// Checking the entries themselves (CURIE keys, conflicting entries) is left to
// the engine, which reports a bad one on every schema it loads.
// ---------------------------------------------------------------------------
function readImportMap(baseDir) {
  const input = getInput("import-map");
  if (!input) return undefined;
  const file = path.resolve(baseDir, input);
  const rel = path.relative(process.cwd(), file);
  if (!fs.existsSync(file)) {
    fail(`import-map file not found: ${rel}`);
    return null;
  }
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`import-map ${rel} is not valid JSON: ${errMessage(e)}`);
    return null;
  }
  if (
    !entries ||
    typeof entries !== "object" ||
    Array.isArray(entries) ||
    !Object.values(entries).every((v) => typeof v === "string")
  ) {
    fail(
      `import-map ${rel} must be a JSON object from an import to the location ` +
        'to load it from, e.g. {"https://example.org/units/": "deps/units/"}.'
    );
    return null;
  }
  const map = {};
  const paths = [];
  for (const [key, loc] of Object.entries(entries)) {
    if (isUri(loc)) {
      map[key] = loc;
      continue;
    }
    const abs = path.resolve(baseDir, loc);
    paths.push(abs);
    // A prefix location keeps its trailing separator, so the rest of the
    // import is appended to it as a path. Working-directory itself has the
    // empty key, which gets no separator: `/` would make the rest absolute.
    const rel = keyFor(baseDir, abs);
    map[key] = rel && /[/\\]$/.test(loc) ? rel + "/" : rel;
  }
  return { map, paths };
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
function loadSchema(file, pool, baseDir, importMap) {
  try {
    const { view, report } = LinkML.loadFromPath(
      keyFor(baseDir, file),
      pool,
      true,
      importMap
    );
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
function runValidate(files, pool, baseDir, importMap, strict, ignore) {
  let problems = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    const { view, issues } = loadSchema(file, pool, baseDir, importMap);
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

// Output name for an input document: its basename without the extension. The
// importers also take JSON and RDF input, so those extensions are stripped too.
const baseName = (file) =>
  path.basename(file).replace(/\.(ya?ml|json|ttl|nt)$/i, "");

function writeSingle(outDir, file, contents, ext) {
  writeAt(path.join(outDir, baseName(file) + ext), contents);
}

function runGenerate(
  files,
  pool,
  baseDir,
  importMap,
  gen,
  genName,
  outDir,
  strict,
  ignore
) {
  let problems = 0;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    const { view, issues } = loadSchema(file, pool, baseDir, importMap);
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
      const base = baseName(file);
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
// Importing is the opposite of generating: the inputs are documents in another
// format, so there is no schema to load and no validation report to go with it.
// The engine can reject a document, which is surfaced the same way as a
// generator throwing – as a synthetic fatal issue, so it stays annotated,
// counted and silenceable via `ignore`. It also lists what it could not import;
// with `list-not-imported` each of those is reported as a `NotImported` warning.
// ---------------------------------------------------------------------------
function runImport(files, imp, impName, outDir, listNotImported, strict, ignore) {
  let problems = 0;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);

    let result;
    try {
      result = imp.run(fs.readFileSync(file, "utf8"));
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
      fail(`${rel}: ${impName} import failed`);
      continue;
    }

    let failed = false;
    if (listNotImported) {
      const issues = (result.warnings ?? []).map((w) => ({
        issue_type: "NotImported",
        severity: "WARNING",
        message: `Not imported: ${w}`,
      }));
      const reported = reportIssues(issues, rel, strict, ignore);
      problems += reported.kept;
      failed = reported.failed;
      if (failed) process.exitCode = 1;
    }

    info(`${failed ? "✗" : "✓"} ${rel}`);
    if (outDir) writeSingle(outDir, file, result.schema, imp.ext);
    else info(`----- ${rel} → LinkML -----\n${result.schema}`);
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

  // Only validate/generate load schemas; an import reads its inputs as text.
  // `importMap` is the parsed `import-map` input, whose local locations are
  // read into the pool along with the inputs and the `imports` directory.
  const pool = (importMap) =>
    buildImportMap(
      baseDir,
      files,
      getInput("imports") ? path.resolve(baseDir, getInput("imports")) : "",
      importMap?.paths
    );
  const outputDir = () =>
    getInput("output") ? path.resolve(baseDir, getInput("output")) : "";
  const ignore = parseIgnore();
  if (ignore === null) return;
  const strict = getBool("strict");

  let problems = 0;
  if (command === "validate") {
    const importMap = readImportMap(baseDir);
    if (importMap === null) return;
    problems = runValidate(
      files,
      pool(importMap),
      baseDir,
      importMap?.map,
      strict,
      ignore
    );
  } else if (command === "generate") {
    const genName = getInput("generator").toLowerCase();
    const format = resolveFor(GENERATOR_FORMATS, genName, "format");
    const errorHandling = resolveFor(ERROR_HANDLING, genName, "error-handling");
    if (format === null || errorHandling === null) return;
    // Blank leaves the choice to the generator, whose defaults differ.
    const modeInput = getInput("pruning-mode").toLowerCase();
    if (modeInput && !Object.hasOwn(PRUNING_MODES, modeInput)) {
      fail(
        `Unknown pruning-mode '${modeInput}'. Expected one of: tree_root, schema, skip.`
      );
      return;
    }
    const metadataProfile = resolveChoice("metadata-profile");
    const permissibleValues = resolveChoice("permissible-values");
    const target = resolveChoice("target");
    const treeRootInlineType = resolveChoice("tree-root-inline-type");
    const indentationStep = resolveCount("indentation-step");
    const resolved = [
      metadataProfile,
      permissibleValues,
      target,
      treeRootInlineType,
      indentationStep,
    ];
    if (resolved.includes(null)) return;
    const generators = buildGenerators({
      open: getBool("open"),
      packageName: getInput("package", "linkml"),
      format: format || undefined,
      errorHandling: errorHandling || undefined,
      pruningMode: modeInput ? PRUNING_MODES[modeInput] : undefined,
      treeRoot: getInput("tree-root") || undefined,
      skipClassesWithoutIdentifier: getBool("skip-classes-without-identifier"),
      onlyRootSchema: getBool("only-root-schema"),
      metadataProfile,
      permissibleValues,
      skipDerivation: getBool("skip-derivation"),
      includeNull: getBool("include-null"),
      optionalMarker: getBool("optional-marker", true),
      target,
      derivedAttributes: getBool("derived-attributes"),
      metadataLanguage: getInput("metadata-language") || undefined,
      fullUris: getBool("full-uris"),
      treeRootInlineType,
      indentationStep,
      optionalDefaults: getBool("optional-defaults"),
      singleFile: getBool("single-file"),
      generateEmitPrefixes: getBool("generate-emit-prefixes", true),
      skipLeafInterfaces: getBool("skip-leaf-interfaces", true),
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
    const importMap = readImportMap(baseDir);
    if (importMap === null) return;
    problems = runGenerate(
      files,
      pool(importMap),
      baseDir,
      importMap?.map,
      gen,
      genName,
      outputDir(),
      strict,
      ignore
    );
  } else if (command === "import") {
    const impName = getInput("importer").toLowerCase();
    const format = resolveFor(IMPORTER_FORMATS, impName, "format");
    if (format === null) return;
    const inputFormat = resolveChoice("input-format");
    if (inputFormat === null) return;
    const owl = impName === "owl";
    const owlConfig = owl ? readOwlConfig(baseDir) : undefined;
    if (owlConfig === null) return;
    const schemaId = getInput("schema-id");
    const importers = buildImporters({
      schemaId,
      format,
      fullUris: getBool("full-uris"),
      owlConfig,
      // The config maps `owl:imports` to LinkML imports, which are relative to
      // where the schema is written – so key the schemas from there.
      importMap: owl
        ? buildImportMap(
            outputDir() || baseDir,
            [],
            getInput("imports") ? path.resolve(baseDir, getInput("imports")) : ""
          )
        : undefined,
      inputFormat,
    });
    const imp = importers[impName];
    if (!imp) {
      fail(
        `Unknown importer '${impName || "(none)"}'. Expected one of: ${Object.keys(
          importers
        ).join(", ")}.`
      );
      return;
    }
    // `schema-id` names the one schema to produce, so it cannot be spread over
    // several inputs – that would give every one of them the same `id`.
    if (schemaId && files.length > 1) {
      fail(
        `\`schema-id\` sets the id of a single schema, but ${files.length} files ` +
          "matched. Import them one at a time, or drop `schema-id` to let each " +
          "schema get its own default id."
      );
      return;
    }
    problems = runImport(
      files,
      imp,
      impName,
      outputDir(),
      getBool("list-not-imported"),
      strict,
      ignore
    );
  } else {
    fail(
      `Unknown command '${command}'. Expected 'validate', 'generate' or 'import'.`
    );
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
