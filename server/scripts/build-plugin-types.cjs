/*
 * Build the plugin declaration boundary, not every implementation it imports.
 * TypeScript still infers the actual host signatures with noCheck disabled.
 * Only declaration-reachable modules are emitted; tsup then removes unused
 * exports. The verifier checks every resulting package declaration separately
 * from third-party declarations (which have upstream compiler incompatibilities).
 */
const ts = require('typescript');
const { build } = require('tsup');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const configPath = path.join(root, 'tsconfig.blinko.json');
const output = path.join(root, 'blinko-types/dist');
const intermediate = fs.mkdtempSync(path.join(root, 'blinko-types/.declarations-'));
const diagnosticHost = {
  getCurrentDirectory: () => root,
  getCanonicalFileName: (name) => name,
  getNewLine: () => '\n',
};
function check(diagnostics) {
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));
}
function packageName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

async function main() {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) check([configFile.error]);
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  check(config.errors);
  if (config.options.noCheck) throw new Error('noCheck is not permitted for plugin declarations.');
  const options = { ...config.options, outDir: intermediate, noCheck: false };
  const checkedFiles = ['app/src/store/plugin/index.ts', 'app/src/store/plugin/services.ts',
    'app/src/store/plugin/hostContext.ts', 'app/src/store/plugin/browserHostContext.ts',
    'app/src/lib/blinkoEndpoint.ts', 'app/src/lib/requestFetch.ts',
    'shared/lib/pluginServices/v1.ts', 'app/src/lib/trpc.ts', 'server/routerTrpc/_app.ts'];
  const program = ts.createProgram([...new Set([...config.fileNames, ...checkedFiles.map(file => path.join(root, file))])], options);
  check(program.getOptionsDiagnostics());
  // Check browser bindings as well as the declaration-reachable boundary. Their
  // implementation is not re-exported into the public package.
  for (const relative of checkedFiles) {
    const source = program.getSourceFile(path.join(root, relative));
    if (!source) throw new Error(`Missing checked source: ${relative}`);
    check(program.getSemanticDiagnostics(source));
  }
  const queue = [...config.fileNames];
  const seen = new Set();
  const external = new Set();
  for (let index = 0; index < queue.length; index++) {
    const input = path.resolve(queue[index]);
    if (seen.has(input)) continue;
    seen.add(input);
    const source = program.getSourceFile(input);
    if (!source) throw new Error(`Missing declaration source: ${input}`);
    check(program.getSyntacticDiagnostics(source));
    const result = program.emit(source, (filename, content) => {
      if (!filename.endsWith('.d.ts')) throw new Error(`Unexpected declaration output: ${filename}`);
      const ast = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const edits = [];
      function visit(node) {
        const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
        if (literal && ts.isStringLiteral(literal)) {
          const specifier = literal.text;
          const resolved = ts.resolveModuleName(specifier, input, options, ts.sys).resolvedModule;
          if (resolved && !resolved.isExternalLibraryImport && resolved.resolvedFileName.startsWith(root + path.sep)
            && !resolved.resolvedFileName.includes(`${path.sep}node_modules${path.sep}`)) {
            queue.push(resolved.resolvedFileName);
            const target = path.join(intermediate, path.relative(root, resolved.resolvedFileName).replace(/\.(tsx?|mts|cts)$/, '.d.ts'));
            let relative = path.relative(path.dirname(filename), target).split(path.sep).join('/').replace(/\.d\.ts$/, '');
            if (!relative.startsWith('.')) relative = './' + relative;
            edits.push([literal.getStart(ast), literal.getEnd(), JSON.stringify(relative)]);
          } else {
            if (!resolved || specifier.startsWith('.') || /^@(shared|server)\//.test(specifier) || specifier.startsWith('@/'))
              throw new Error(`Unresolved or nonportable type import ${specifier} in ${input}`);
            external.add(packageName(specifier));
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
        content = content.slice(0, start) + replacement + content.slice(end);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }, undefined, true);
    check(result.diagnostics);
    if (result.emitSkipped) throw new Error(`Declaration emission skipped: ${input}`);
  }
  await build({
    entry: {
      index: path.join(intermediate, 'app/src/store/plugin/index.d.ts'),
      services: path.join(intermediate, 'app/src/store/plugin/services.d.ts'),
    },
    dts: { only: true, compilerOptions: { paths: undefined, baseUrl: undefined } },
    format: ['esm'],
    tsconfig: configPath,
    outDir: output,
    external: [...external],
    clean: false,
  });
  // The only retained Prisma namespace members are runtime value types. Import
  // their stable definitions directly, so plugin authors do not need our schema
  // or a locally generated Prisma client just to compile their plugin.
  const indexFile = path.join(output, 'index.d.mts');
  const indexText = fs.readFileSync(indexFile, 'utf8');
  fs.writeFileSync(indexFile, indexText.replace("import { Prisma } from '@prisma/client';", "import type * as Prisma from '@prisma/client/runtime/library';"));
  console.log(`Plugin declarations: ${seen.size} reachable source modules emitted with noCheck=false.`);
  // The retained intermediate tree is ignored by Git. It is intentionally kept
  // on failure for diagnosis; no recursive deletion or cleanup of user paths.
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
