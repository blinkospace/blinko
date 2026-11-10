import type { BasePlugin, I18nString, PluginServicesSdk } from 'blinko';
import type { PluginServicesSdk as ServicesSdk } from 'blinko/services';

type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type LegacyApiStillTyped = Assert<IsAny<Window['Blinko']['api']> extends false ? true : false>;
type ServicesAgree = Assert<ServicesSdk extends PluginServicesSdk ? true : false>;

export class LegacyPlugin implements BasePlugin {
  displayName: I18nString = { default: 'Synthetic legacy plugin' };
  init(): void {
    void window.Blinko.api.notes.list.mutate({ page: 1, size: 10 }).then((notes) => {
      const content: string | undefined = notes[0]?.content;
      const createdAt: Date | undefined = notes[0]?.createdAt;
      void [content, createdAt];
    });
    window.Blinko.addToolBarIcon({ name: 'synthetic', icon: 'test', tooltip: 'test' });
    const preference = new window.Blinko.store.StorageState<number>({ key: 'synthetic', default: 1 });
    preference.save(2);
    window.Blinko.globalRefresh();
  }
  destroy(): void { window.Blinko.closeToolBarContent('synthetic'); }
}

// These must be rejected; a blanket any or shortened substitute API fails this fixture.
// @ts-expect-error notes.list is a mutation, just as in the existing host.
window.Blinko.api.notes.list.query({ page: 1 });
// @ts-expect-error the legacy page size remains a number.
window.Blinko.api.notes.list.mutate({ size: 'ten' });
// @ts-expect-error nonexistent routes must not typecheck.
window.Blinko.api.notes.aRouteThatDoesNotExist.mutate({});
// @ts-expect-error initialization and destruction remain required.
const missingLifecycle: BasePlugin = {};
void missingLifecycle;

const sdk: PluginServicesSdk = window.Blinko.services;
void sdk.capabilities().then((value) => {
  const version: '1.0' = value.apiVersion;
  void version;
});
void sdk.vector.status();
// @ts-expect-error a note query needs a numeric note ID.
void sdk.vector.query({ source: { kind: 'note', noteId: '1' } });
export type Verified = [LegacyApiStillTyped, ServicesAgree];
