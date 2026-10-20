import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const jsx = (type, props) => ({ type, props });
function load(relative, dependencies) {
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name === 'mobx-react-lite') return { observer: fn => fn };
    if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) };
    assert.ok(name in dependencies, `Unmocked import: ${name}`);
    return dependencies[name];
  } });
  return exports;
}
function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
}

function deletion(status) {
  const file = { name: 'synthetic.webm', uploadPromise: { value: '/synthetic.webm', loading: { value: false } } };
  const files = [file], draft = [file];
  let closes = 0;
  const store = {
    close: () => { closes++; }, success() {},
    removeCreateAttachments: file => { const i = draft.findIndex(f => f.name === file.name); if (i >= 0) draft.splice(i, 1); },
  };
  const { DeleteIcon } = load('../../AttachmentRender/icons.tsx', {
    '@/components/Common/Iconify/icons': { Icon: 'Icon' },
    '@/store': { RootStore: { Local: fn => fn(), Get: () => store } },
    '@/components/Common/TipsDialog': { TipsPopover: 'TipsPopover' },
    '@/store/module/Toast/Toast': { ToastPlugin: {} },
    '@/store/blinkoStore': { BlinkoStore: {} },
    '@/store/module/DialogStandalone': { DialogStandaloneStore: {} },
    '@/store/standard/PromiseState': { PromiseState: class {
      loading = { value: false };
      constructor({ function: fn }) { this.fn = fn; }
      async call(...args) { try { return await this.fn(...args); } catch { return undefined; } }
    } },
    '@heroui/react': { Tooltip: 'Tooltip' },
    '@/lib/event': { eventBus: {} },
    '@/lib/blinkoEndpoint': { getBlinkoEndpoint: path => path },
    '@/lib/axios': { default: { post: async () => { if (status) throw { response: { status } }; } } },
    '@/lib/tauriHelper': { downloadFromLink() {} },
  });
  const tree = DeleteIcon({ file, files, voice: true, className: '' });
  return { files, draft, get closes() { return closes; }, nodes: descendants(tree) };
}

for (const status of [undefined, 404]) test(`voice deletion removes the persisted draft without closing its editor (${status || 200})`, async () => {
  const f = deletion(status);
  const popup = f.nodes.find(n => n.type === 'TipsPopover');
  assert.equal(popup.props.keepParentOpen, true);
  const button = f.nodes.find(n => n.type === 'button');
  assert.equal(button.props['aria-label'], 'delete');
  assert.ok(!button.props.className.includes('opacity-0'));
  assert.ok(button.props.className.includes('!bg-transparent p-2'));
  const face = button.props.children;
  assert.equal(face.type, 'span');
  assert.equal(face.props.className, 'flex bg-black rounded-sm pointer-events-none');
  assert.equal(face.props.children.props.width, 20);
  assert.equal(face.props.children.props.height, 20);
  let stopped = false;
  button.props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(await popup.props.onConfirm(), true);
  assert.equal(f.files.length, 0);
  assert.equal(f.draft.length, 0);
  assert.equal(f.closes, 0);
});

test('permission or server errors retain the attachment and saved draft', async () => {
  const f = deletion(403);
  assert.equal(await f.nodes.find(n => n.type === 'TipsPopover').props.onConfirm(), false);
  assert.equal(f.files.length, 1);
  assert.equal(f.draft.length, 1);
});

test('cancelling the voice confirmation closes only the popover', () => {
  let closes = 0, open = true;
  const { TipsPopover } = load('../../TipsDialog/index.tsx', {
    '@/store': { RootStore: { Get: () => ({ close() { closes++; } }) } },
    '@/components/Common/Iconify/icons': { Icon: 'Icon' },
    '@/store/module/DialogStandalone': { DialogStandaloneStore: {} },
    '@heroui/react': Object.fromEntries(['Popover', 'PopoverTrigger', 'PopoverContent', 'Button'].map(x => [x, x])),
    react: { useState: () => [open, value => { open = value; }] },
  });
  const nodes = descendants(TipsPopover({ children: null, content: 'confirm', keepParentOpen: true }));
  let stopped = false;
  nodes.find(n => n.type === 'Button' && n.props.children === 'cancel').props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(open, false);
  assert.equal(closes, 0);
});

test('viewport rerenders preserve the dialog content component identity', () => {
  const modal = { content: { type: 'Recorder' }, isOpen: true, onlyContent: true };
  let memo, desktop = false;
  const { default: Dialog } = load('../../../../store/module/DialogStandalone/Provider.tsx', {
    '@heroui/react': Object.fromEntries(['Button', 'Modal', 'ModalBody', 'ModalContent', 'ModalHeader'].map(x => [x, x])),
    '.': { DialogStandaloneStore: {} },
    '@/store/root': { RootStore: { Get: () => modal } },
    '@/lib/hooks': { useHistoryBack() {}, useIsIOS: () => false },
    'usehooks-ts': { useMediaQuery: () => desktop },
    'motion/react': { motion: { div: 'div' } },
    '@/components/Common/Iconify/icons': { Icon: 'Icon' },
    '@/components/Common/Icons': { CancelIcon: 'CancelIcon' },
    react: { useMemo: (fn, deps) => {
      if (!memo || memo.dep !== deps[0]) memo = { dep: deps[0], value: fn() };
      return memo.value;
    } },
  });
  const contentType = () => descendants(Dialog()).find(n => n.type === 'ModalContent').props.children.flat().find(n => typeof n?.type === 'function').type;
  const first = contentType();
  desktop = true;
  assert.equal(contentType(), first);
  assert.equal(first(), modal.content);
});
