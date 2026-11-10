// This consumer intentionally has no DOM or automatically included Node types.
import type { PluginServicesSdk, VectorQueryResult, CallOptions } from 'blinko/services';
declare const sdk: PluginServicesSdk;
const options: CallOptions = { signal: { aborted: false, addEventListener() {}, removeEventListener() {} } };
const result: Promise<VectorQueryResult> = sdk.vector.query({ source: { kind: 'note', noteId: 1 } }, options);
void result;
void sdk.capabilities();
void sdk.ai.generateText({ messages: [{ role: 'user', content: 'Synthetic' }], idempotencyKey: 'synthetic' });
if (sdk.context && sdk.files) {
  const initial = sdk.context.get();
  const stop = sdk.context.subscribe(current => {
    const identity: string = current.identityKey;
    const account: number | null = current.accountId;
    const endpoint: string | null = current.serviceUrl;
    void [identity, account, endpoint, initial.authentication];
  }, options);
  const image: string = sdk.files.url('/api/file/synthetic.png', { thumbnail: true });
  void image;
  stop();
  // @ts-expect-error public identity never exposes credentials.
  void initial.token;
  // @ts-expect-error callers cannot inject credentials through public file options.
  void sdk.files.url('/api/file/synthetic.png', { token: 'synthetic' });
  // @ts-expect-error subscriptions must take a callback.
  sdk.context.subscribe('listener');
}
// @ts-expect-error output tokens must remain numeric.
void sdk.ai.generateText({ messages: [], idempotencyKey: 'synthetic', maxOutputTokens: 'many' });
