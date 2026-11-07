import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Regression test: a failed save must not throw away what the user typed.
 *
 * `blinko.upsertNote` is a PromiseState: when the request fails it shows the error
 * toast and resolves to `undefined` instead of rejecting. BlinkoEditor's `onSend`
 * used to carry on as if the note had been saved: it cleared the local draft, and
 * because it resolved normally `EditorStore.handleSend` then cleared the editor too,
 * so the note was gone. `onSend` must reject when nothing was saved; `handleSend`
 * already keeps the editor when `onSend` rejects.
 *
 * React, the router and the stores are mocked so the component's real `onSend`
 * can be called without rendering the editor.
 */

let editorProps: any = null;
const Editor = (props: any) => {
  editorProps = props;
  return null;
};
const jsx = (type: any, props: any) => (type === Editor ? Editor(props) : null);

const upsertCall = mock(async (_params: any): Promise<any> => undefined);
const navigate = mock(async (_to: string) => {});
const blinko: any = {};
const resetBlinko = () => {
  Object.assign(blinko, {
    noteContent: 'an idea that must not be lost',
    curSelectedNote: null,
    noteTypeDefault: 0,
    isCreateMode: true,
    updateTicker: 0,
    forceQuery: 0,
    upsertNote: { call: upsertCall, loading: { value: false } },
    createContentStorage: { value: { content: 'an idea that must not be lost' }, clear: mock(() => {}), save: mock(() => {}) },
    createAttachmentsStorage: { list: [], clear: mock(() => {}) },
    editContentStorage: { list: [{ id: 7, content: 'edited text' }], remove: mock((_i: number) => {}), save: mock(() => {}), push: mock(() => {}) },
    editAttachmentsStorage: { list: [{ id: 7 }], remove: mock((_i: number) => {}) },
  });
};
class BlinkoStore {}

mock.module('react', () => ({ useEffect: () => {}, useRef: () => ({ current: null }) }));
mock.module('react/jsx-runtime', () => ({ jsx, jsxs: jsx, Fragment: 'fragment' }));
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: jsx, Fragment: 'fragment' }));
mock.module('mobx-react-lite', () => ({ observer: (component: any) => component }));
mock.module('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/' }),
  useSearchParams: () => [new URLSearchParams()],
}));
mock.module('../../../../app/src/components/Common/Editor', () => ({ default: Editor }));
mock.module('../../../../app/src/store', () => ({ RootStore: { Get: () => blinko, Local: (factory: () => any) => factory() } }));
mock.module('../../../../app/src/store/blinkoStore', () => ({ BlinkoStore }));
mock.module('../../../../app/src/lib/dayjs', () => ({ default: () => ({ format: () => '' }) }));

const { BlinkoEditor } = await import('../../../../app/src/components/BlinkoEditor');

const sendArgs = { content: '', files: [], references: [], noteType: 0, metadata: {} };

beforeEach(() => {
  resetBlinko();
  editorProps = null;
  upsertCall.mockReset();
  navigate.mockClear();
});

describe('BlinkoEditor onSend', () => {
  test('create: a failed save rejects and keeps the local draft', async () => {
    (BlinkoEditor as any)({ mode: 'create' });
    upsertCall.mockImplementation(async () => undefined);

    await expect(editorProps.onSend(sendArgs)).rejects.toThrow();
    expect(upsertCall).toHaveBeenCalledTimes(1);
    expect(blinko.createContentStorage.clear).not.toHaveBeenCalled();
    expect(blinko.createAttachmentsStorage.clear).not.toHaveBeenCalled();
  });

  test('create: a successful save clears the local draft', async () => {
    (BlinkoEditor as any)({ mode: 'create' });
    upsertCall.mockImplementation(async () => ({ id: 1, content: blinko.noteContent }));

    await editorProps.onSend(sendArgs);
    expect(blinko.createContentStorage.clear).toHaveBeenCalledTimes(1);
    expect(blinko.createAttachmentsStorage.clear).toHaveBeenCalledTimes(1);
  });

  test('edit: a failed save rejects, keeps the edit draft and does not report the note as sent', async () => {
    blinko.curSelectedNote = { id: 7, content: 'edited text', references: [], attachments: [] };
    const onSended = mock(() => {});
    (BlinkoEditor as any)({ mode: 'edit', onSended });
    upsertCall.mockImplementation(async () => undefined);

    await expect(editorProps.onSend(sendArgs)).rejects.toThrow();
    expect(blinko.editContentStorage.remove).not.toHaveBeenCalled();
    expect(blinko.editAttachmentsStorage.remove).not.toHaveBeenCalled();
    expect(onSended).not.toHaveBeenCalled();
  });

  test('edit: a successful save removes the edit draft and reports the note as sent', async () => {
    blinko.curSelectedNote = { id: 7, content: 'edited text', references: [], attachments: [] };
    const onSended = mock(() => {});
    (BlinkoEditor as any)({ mode: 'edit', onSended });
    upsertCall.mockImplementation(async () => ({ id: 7, content: 'edited text' }));

    await editorProps.onSend(sendArgs);
    expect(blinko.editContentStorage.remove).toHaveBeenCalledTimes(1);
    expect(onSended).toHaveBeenCalledTimes(1);
  });
});
