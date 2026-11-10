/* Verify the actual packed package without repository paths or source imports. */
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const packageRoot = path.join(root, 'blinko-types');
const run = fs.mkdtempSync(path.join(packageRoot, '.declarations-consumer-'));
const modules = path.join(run, 'node_modules');
const installed = path.join(modules, 'blinko');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const dependencyNames = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
const diagnosticHost = { getCurrentDirectory: () => run, getCanonicalFileName: name => name, getNewLine: () => '\n' };
function check(diagnostics, label) {
  if (diagnostics.length) throw new Error(label + '\n' + ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));
}
function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(run, 'npm-cache') } });
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}
function nameOf(specifier) { return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]; }
function isDeclared(specifier) {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) return true;
  const name = nameOf(specifier);
  const types = '@types/' + name.replace(/^@/, '').replace('/', '__');
  return dependencyNames.includes(name) || dependencyNames.includes(types);
}
function audit(file) {
  const text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
    if (literal && ts.isStringLiteral(literal)) {
      const specifier = literal.text;
      if (specifier.includes('node_modules') || specifier.startsWith('/') || specifier.startsWith('@/') || /^@(server|shared)\//.test(specifier))
        throw new Error(`Nonportable declaration import: ${specifier}`);
      if (!specifier.startsWith('.') && !isDeclared(specifier)) throw new Error(`Undeclared type dependency: ${specifier}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
function options(dom) {
  return {
    strict: true, noEmit: true, noCheck: false, skipLibCheck: false,
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, esModuleInterop: true,
    lib: dom ? ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] : ['lib.es2020.d.ts'],
    types: dom ? ['node', 'react', 'systemjs'] : [],
    typeRoots: [path.join(modules, '@types')],
    jsx: ts.JsxEmit.ReactJSX,
  };
}
function checkDeclarations(file, dom) {
  const program = ts.createProgram([file], options(dom));
  const own = program.getSourceFiles().filter(source => source.fileName.startsWith(installed + path.sep));
  check([...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()], 'Package configuration');
  for (const source of own)
    check([...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)], 'Public declaration error');
  for (const source of program.getSourceFiles()) {
    if (source.fileName.includes(`${path.sep}.prisma${path.sep}`)) throw new Error('Consumer unexpectedly needs a generated Prisma client.');
    if (!source.isDeclarationFile) throw new Error(`Consumer unexpectedly needs implementation source: ${source.fileName}`);
  }
  if (!own.length) throw new Error('No packed declarations were checked.');
  console.log(`Strict public declaration check: ${own.length} files, DOM=${dom}, noCheck=false, skipLibCheck=false.`);
}
function checkConsumer(fixture, dom) {
  const file = path.join(run, fixture);
  fs.copyFileSync(path.join(packageRoot, 'fixtures', fixture), file);
  // Public declarations are checked above with skipLibCheck=false. This common
  // consumer setting excludes upstream third-party .d.ts incompatibilities only;
  // strict checking and the negative assertions in the consumer remain enabled.
  const program = ts.createProgram([file], { ...options(dom), skipLibCheck: true });
  check(ts.getPreEmitDiagnostics(program), `Packed consumer ${fixture}`);
  console.log(`Packed consumer: ${fixture} passed without paths/baseUrl (${dom ? 'DOM' : 'no DOM/Node globals'}).`);
}
try {
  const pack = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', run], packageRoot))[0];
  fs.mkdirSync(installed, { recursive: true });
  const archive = path.resolve(run, pack.filename);
  if (path.dirname(archive) !== run) throw new Error('Unexpected package archive path.');
  command('tar', ['-xzf', archive, '-C', installed, '--strip-components=1'], run);
  for (const name of dependencyNames) {
    const target = path.join(root, 'node_modules', name);
    if (!fs.existsSync(target)) throw new Error(`Install the pinned type dependency before verifying: ${name}`);
    const link = path.join(modules, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'dir');
  }
  const files = ['dist/index.d.mts', 'dist/services.d.mts'].map(file => path.join(installed, file));
  for (const file of files) audit(file);
  checkDeclarations(files[0], true);
  checkDeclarations(files[1], false);
  checkConsumer('legacy-consumer.ts', true);
  checkConsumer('services-consumer.ts', false);
  // Compile the actual independent example against the installed archive, not
  // repository aliases or a separate handwritten SDK lookalike.
  fs.copyFileSync(path.join(root, 'docs/plugin-services/examples/similar-content/plugin.ts'), path.join(run, 'similar-content-plugin.ts'));
  checkConsumer('prepared-content-consumer.ts', true);
  console.log(`Verified archive: ${archive} (${pack.shasum}); declarations only, no private sources or generated Prisma schema.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
