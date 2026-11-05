import { beforeEach, expect, mock, test } from 'bun:test';
import { newPendingTwoFactor } from '../../../app/src/lib/pendingTwoFactor';

let effects: Array<() => any> = [];
let route = { pathname: '/oauth-callback', hash: '', search: '' };
const navigate = mock(() => {});
const profile = mock(async (): Promise<any> => null);
const verify = mock(async (..._args: any[]) => ({ ok: false }));
const modal = mock((_callback: (code: string) => Promise<any>, _loading: boolean) => {});
const replaceState = mock(() => {});
const store: any = { tokenData: { value: null, save(value: any) { this.value = value; } } };
const toast = { error: mock(() => {}) };
class UserStore {}
class ToastPlugin {}
class DialogStore {}
mock.module('react', () => ({
  useEffect: (callback: () => any) => effects.push(callback),
  useState: (initial: any) => [initial, () => {}],
}));
mock.module('react/jsx-runtime', () => ({ jsx: () => null, jsxs: () => null }));
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: () => null }));
mock.module('react-router-dom', () => ({ useNavigate: () => navigate, useLocation: () => route }));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module('../../../app/src/components/Common/TwoFactorModal', () => ({ ShowTwoFactorModal: modal }));
mock.module('../../../app/src/components/Common/LoadingPage', () => ({ LoadingPage: () => null }));
mock.module('../../../app/src/components/Auth/auth-client', () => ({ signIn: verify, getTokenData: profile }));
mock.module('../../../app/src/store/user', () => ({ UserStore }));
mock.module('../../../app/src/store/module/Toast/Toast', () => ({ ToastPlugin }));
mock.module('../../../app/src/store/module/Dialog', () => ({ DialogStore }));
mock.module('../../../app/src/store', () => ({ RootStore: { Get: (kind: any) => kind === UserStore ? store : kind === ToastPlugin ? toast : { close() {} } } }));
mock.module('../../../app/src/lib/event', () => ({ eventBus: { on() {}, off() {}, emit() {} } }));
mock.module('@heroui/react', () => ({ Button: () => null }));
const { default: OAuthCallback } = await import('../../../app/src/pages/oauth-callback');
const render = async () => {
  effects = [];
  OAuthCallback();
  effects.forEach((effect) => effect());
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  route = { pathname: '/oauth-callback', hash: '', search: '' };
  (globalThis as any).window = { location: { pathname: '/oauth-callback' }, history: { replaceState } };
  store.tokenData.value = null;
  for (const call of [navigate, profile, verify, modal, replaceState, toast.error]) call.mockClear();
  profile.mockImplementation(async () => null);
});

test('refresh after scrubbing restores the pending modal without requesting a bearer profile', async () => {
  const challenge = 'a'.repeat(64);
  route.hash = `#requiresTwoFactor=true&userId=42&challenge=${challenge}`;
  await render();
  expect(replaceState).toHaveBeenCalledWith(null, '', '/oauth-callback');
  const saved = JSON.parse(JSON.stringify(store.tokenData.value));
  route.hash = '';
  store.tokenData.value = saved;
  modal.mockClear();
  await render();
  expect(modal).toHaveBeenCalledTimes(1);
  expect(profile).not.toHaveBeenCalled();
  await modal.mock.calls[0][0]('123456');
  expect(verify).toHaveBeenCalledWith('oauth-2fa', {
    userId: '42', challenge, twoFactorCode: '123456', callbackUrl: '/', redirect: false,
  });
});
test('expired saved challenges are cleared instead of reopening a dead modal', async () => {
  store.tokenData.value = newPendingTwoFactor('42', 'b'.repeat(64), Date.now() - 300001);
  await render();
  expect(store.tokenData.value).toBeNull();
  expect(modal).not.toHaveBeenCalled();
  expect(profile).not.toHaveBeenCalled();
});
test('a new successful OAuth callback supersedes an earlier pending challenge', async () => {
  store.tokenData.value = newPendingTwoFactor('42', 'c'.repeat(64));
  route.hash = '#success=true&token=new-session';
  profile.mockImplementation(async () => ({ user: { id: '45' } }));
  await render();
  expect(profile).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('/');
  expect(modal).not.toHaveBeenCalled();
});
test('malformed callback challenge never falls back to a different saved challenge', async () => {
  store.tokenData.value = newPendingTwoFactor('42', 'd'.repeat(64));
  route.hash = '#requiresTwoFactor=true&userId=45&challenge=invalid';
  await render();
  expect(store.tokenData.value).toBeNull();
  expect(modal).not.toHaveBeenCalled();
  expect(profile).not.toHaveBeenCalled();
});
