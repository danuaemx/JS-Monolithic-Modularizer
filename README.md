# JS Monolithic Modularizer

A browser-based tool that takes a **single monolithic `.js` file** and generates a modular ES Module structure (`index.js`, `core`, `features`, `utils`) as a downloadable ZIP.

This project uses local support libraries from `vendor/`: Tailwind CSS, Acorn, acorn-walk, and JSZip.

---

## What this tool does

- Accepts one JavaScript input file.
- Parses source code into an AST.
- Detects functions, classes, top-level calls, and top-level state.
- Builds a function call graph.
- Groups functions into clusters (`utils` + `featureN`).
- Generates modular files with imports/exports resolved.
- Shows generated folders/files before download.
- Exports a ZIP **manually** (no automatic download).

---

## End-to-end flow

1. **Pre-validation**
   - Parses the file first.
   - Blocks if syntax is invalid.
   - Emits warnings for risky patterns.

2. **AST analysis**
   - Extracts top-level declarations.
   - Separates function/class declarations from generic top-level code.
   - Detects DOM selector declarations and state declarations.

3. **Mobility analysis**
   - Detects functions that depend on top-level scoped state/DOM and marks them as **non-movable**.

4. **Call graph & clustering**
   - Builds caller/callee relationships between discovered functions.
   - Functions with high in-degree (>=2) are grouped into `utils`.
   - Remaining functions are grouped by connected components and split by max size.

5. **Module generation**
   - Maps each entity to target module paths.
   - Optionally creates hierarchical feature folders when dependency count crosses threshold.
   - Computes cross-module dependencies and required exports.

6. **Runtime consolidation**
   - Consolidates non-movable code into a runtime module.
   - Generates entrypoint `index.js` with imports and top-level calls.

7. **Output preview & ZIP**
   - Renders generated tree (folders/files).
   - Allows manual ZIP download.

---

## Modularization algorithm details

### 1) Pre-validation rules

The pre-check warns about patterns that can reduce transformation accuracy:

- very large files
- many top-level statements
- CommonJS usage (`require`, `module.exports`, `exports.*`)
- dynamic `import()`
- `eval()`
- `with` statements

If syntax parsing fails, modularization stops immediately.

### 2) Declaration extraction

The analyzer scans top-level AST nodes and records:

- `functionSources`
- `classSources`
- top-level callable entries
- top-level state (especially `let`-based declarations)
- DOM element selector declarations
- other top-level code fragments

### 3) Non-movable function detection

A function is marked non-movable if it references scoped top-level variables in a way that is not shadowed in local scope.

Those functions are later merged into runtime to preserve behavior.

### 4) Cluster strategy

- **`utils` cluster**: functions called by multiple functions (in-degree >= 2).
- **feature clusters**: connected components from bidirectional call relationships (caller + callee graph), chunked by max functions per module.

### 5) Dependency & export resolution

For each generated module, identifier references are analyzed to build import lists.

Exports are calculated from:

- top-level calls from entrypoint
- cross-module symbol usage
- runtime-accessed symbols

### 6) Runtime and entrypoint generation

- Runtime file receives non-movable logic + required imports/exports.
- Entry `index.js` imports runtime and calls top-level functions in order.

---

## Output customization

The UI allows customizing:

- ZIP file name
- output root folder
- features folder name
- core folder name
- file naming style (`kebab`, `snake`, `camel`)
- hierarchy threshold (0 disables nested feature grouping)
- max functions per cluster

---

## Scope (what this tool is good at)

Best suited for:

- plain JavaScript files with top-level functions/classes
- front-end scripts needing first-step modular decomposition
- educational/refactoring workflows where structure matters more than bundler integration

---

## Current limitations

- Works on one input file at a time.
- Does not generate test files.
- Does not update external build tooling (Webpack/Vite/Rollup config).
- Highly dynamic patterns may require manual review.
- Output is ES Modules and may need small manual edits in edge cases.

---

## Important runtime note

Generated modularized files use ES modules and **cannot be executed directly with `file://`**.

Use a local/remote web server instead.

Examples:

- `python3 -m http.server 8080`
- `npx serve .`

---

## Libraries used

This project uses local copies in `vendor/`:

| Library | Purpose | Local file |
|---|---|---|
| Tailwind CSS (browser build) | UI utility classes | `vendor/tailwindcss.js` |
| Acorn | JavaScript parser (AST) | `vendor/acorn.min.js` |
| acorn-walk | AST traversal helpers | `vendor/acorn-walk.min.js` |
| JSZip | ZIP generation in browser | `vendor/jszip.min.js` |

---

## Project structure

- `index.html` — app shell
- `assets/css/styles.css` — UI styles
- `src/core/runtime.js` — UI logic + orchestration + pre-validation
- `src/features/analyze-a-s-t.js` — AST extraction & mobility analysis
- `src/features/create-clusters.js` — call-graph clustering
- `src/features/generate-module-files.js` — modular file synthesis
- `src/features/create-zip.js` — ZIP generation
- `src/utils.js` — dependency/import utilities
- `.github/workflows/deploy-pages.yml` — GitHub Pages deployment workflow

---

## Run locally

Because this is a static app, no build is required.

1. Serve the project directory with a local server.
2. Open `index.html` through HTTP (not `file://`).

---

## Deploy to GitHub Pages

A workflow is already provided in `.github/workflows/deploy-pages.yml`.

- Push to `main` or `master`.
- In GitHub repository settings, set Pages source to **GitHub Actions**.

---

## License

See `LICENSE`.
