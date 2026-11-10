import { expect, test } from 'bun:test';
import { build } from 'esbuild';
import path from 'node:path';
import vm from 'node:vm';

test('actual plugin manager mounts services while preserving the legacy API and init/destroy lifecycle', async () => {
  const managerFile = path.resolve(import.meta.dir, '../../../app/src/store/plugin/pluginManagerStore.ts');
  const entryFile = path.resolve(import.meta.dir, '../../../app/src/store/plugin/index.ts');
  const stubs: Record<string, string> = {
    'systemjs/dist/system.js': 'globalThis.System = globalThis.__fixture.system;',
    '@/lib/trpc': 'export const api = globalThis.__fixture.api;',
    '@/lib/event': 'export const eventBus = {};',
    '@/lib/i18n': 'export default {t: value => value};',
    '../root': 'export const RootStore = {Get: Type => Type.name === "PluginApiStore" ? globalThis.__fixture.pluginApi : {updateTicker: 0}};',
    'mobx': 'export const makeAutoObservable = () => {}; export const reaction = () => () => {};',
    'copy-to-clipboard': 'export default () => true;',
    '../standard/StorageState': 'export class StorageState { constructor(args) {this.value = args.value ?? args.default ?? "";} save(value) {this.value = value;} }',
    '../standard/PromiseState': 'export class PromiseState {constructor(args){Object.assign(this,args);} async call(...args){return this.function(...args);} } export class PromisePageState extends PromiseState {}',
  };
  for (const [specifier, name] of Object.entries({
    './pluginApiStore': 'PluginApiStore', '../module/Toast/Toast': 'ToastPlugin',
    '../blinkoStore': 'BlinkoStore', '../baseStore': 'BaseStore',
    '../resourceStore': 'ResourceStore', '../hubStore': 'HubStore', '../user': 'UserStore',
  })) stubs[specifier] = `export class ${name} {}`;
  const result = await build({
    stdin: { contents: `export {PluginManagerStore} from ${JSON.stringify(managerFile)}; export {BasePlugin} from ${JSON.stringify(entryFile)};`, resolveDir: path.dirname(managerFile), loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2020',
    plugins: [{ name: 'isolated-ui-infrastructure', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => (args.importer === managerFile || args.path === 'mobx') && args.path in stubs ? {path: args.path, namespace: 'fixture'} : undefined);
      builder.onLoad({filter: /.*/, namespace: 'fixture'}, args => ({ contents: stubs[args.path], loader: 'js' }));
    }}],
  });
  let legacyCalls = 0, initialized = 0, destroyed = 0, moduleDeletes = 0;
  const api = {
    notes: {list: {mutate: async () => { legacyCalls++; return []; }}},
    plugin: {getPluginCssContents: {query: async () => []}},
  };
  const pluginApi = Object.fromEntries([
    'addToolBarIcon', 'addRightClickMenu', 'addAiWritePrompt', 'showDialog', 'closeDialog',
    'closeToolBarContent', 'addCardFooterSlot', 'addEditorFooterSlot', 'getEditorMetadata',
    'setEditorMetadata', 'getActiveEditorStore',
  ].map(name => [name, () => undefined]));
  const fixture = { api, pluginApi, system: { import: async (_name: string): Promise<unknown> => ({}), delete: () => {moduleDeletes++; return false;} } };
  const module = {exports: {}};
  const context = vm.createContext({ module, exports: module.exports, window: {}, __fixture: fixture, console });
  vm.runInContext(result.outputFiles[0]!.text, context);
  const {PluginManagerStore, BasePlugin} = module.exports as {
    PluginManagerStore: new () => {loadPlugin(path: string): Promise<unknown>; destroyPlugin(name: string): Promise<void>; getPluginInstanceByName(name: string): unknown; initBlinkoContext(): void; disposePluginServices(): void};
    BasePlugin: new (options: Record<string, unknown>) => object;
  };
  class LegacyPlugin extends BasePlugin {
    constructor() { super({name: 'synthetic-legacy'}); }
    init() { initialized++; void context.window.Blinko.api.notes.list.mutate({page: 1}); }
    destroy() { destroyed++; }
  }
  fixture.system.import = async () => ({default: LegacyPlugin});
  const manager = new PluginManagerStore();
  expect(context.window.Blinko.api).toBe(api);
  expect(typeof context.window.Blinko.services.capabilities).toBe('function');
  expect(context.window.Blinko.services.apiVersion).toBe('1.0');
  expect(typeof context.window.Blinko.services.context.get).toBe('function');
  expect(typeof context.window.Blinko.services.files.url).toBe('function');
  const previousServices = context.window.Blinko.services;
  let contextNotifications = 0;
  previousServices.context.subscribe(() => { contextNotifications++; });
  manager.initBlinkoContext();
  expect(contextNotifications).toBe(2);
  expect(context.window.Blinko.services).not.toBe(previousServices);
  await expect(previousServices.vector.status()).rejects.toMatchObject({ code: 'ABORTED' });
  await manager.loadPlugin('/plugins/synthetic-legacy/main.js');
  expect(initialized).toBe(1);
  expect(legacyCalls).toBe(1);
  expect(manager.getPluginInstanceByName('synthetic-legacy')).toBeInstanceOf(LegacyPlugin);
  await manager.destroyPlugin('synthetic-legacy');
  expect(destroyed).toBe(1);
  expect(moduleDeletes).toBe(1);
  expect(manager.getPluginInstanceByName('synthetic-legacy')).toBeUndefined();
  manager.disposePluginServices();
});
