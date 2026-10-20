import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

test('voice removal is visible on touch and cancellation does not reopen or play audio', async t => {
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    t.skip('Requires Playwright and a local Chrome installation');
    return;
  }
  t.after(() => browser.close());
  const tipsPath = fileURLToPath(new URL('../../TipsDialog/index.tsx', import.meta.url));
  const result = await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {TipsPopover} from ${JSON.stringify(tipsPath)};
      window.plays = 0; window.deletes = 0;
      createRoot(document.getElementById('root')).render(
        <div className="voice-message" onClick={() => window.plays++}>
          <TipsPopover keepParentOpen content="Remove attachment?" onConfirm={() => {window.deletes++; return true;}}>
            <button className="voice-attachment-remove" onClick={e => e.stopPropagation()}>X</button>
          </TipsPopover>
        </div>);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, jsx: 'automatic', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'isolated-ui', setup(b) {
      b.onResolve({ filter: /^(@\/|react-i18next$|mobx-react-lite$)/ }, args => ({ path: args.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
        export const RootStore = {Get: () => ({close() {throw new Error('Editor must stay open')}})};
        export const DialogStandaloneStore = {};
        export const Icon = () => null;
        export const observer = fn => fn;
        export const useTranslation = () => ({t: key => key});
      ` }));
      // Resolve in Node: esbuild otherwise scans inaccessible parent folders on Windows.
      b.onResolve({ filter: /^@heroui\/react$/ }, () => ({ path: 'heroui', namespace: 'ui' }));
      b.onLoad({ filter: /.*/, namespace: 'ui' }, () => ({ contents: 'export * from "@heroui/popover"; export * from "@heroui/button";' }));
      b.onResolve({ filter: /.*/ }, args => {
        try {
          return { path: path.isAbsolute(args.path) ? args.path : createRequire(path.isAbsolute(args.importer) ? args.importer : import.meta.url).resolve(args.path), namespace: 'local' };
        } catch (error) {
          if (args.path === '@emotion/is-prop-valid') return { path: args.path, external: true };
          throw error;
        }
      });
      b.onLoad({ filter: /.*/, namespace: 'local' }, args => ({
        contents: readFileSync(args.path, 'utf8'), loader: args.path.endsWith('.tsx') ? 'tsx' : 'js',
      }));
    } }],
  });
  const css = readFileSync(new URL('../../../../styles/globals.css', import.meta.url), 'utf8')
    .split('.bm-burger-button')[0].replace(/^@(?:import|config).*$/gm, '');
  for (const touch of [true, false]) {
    const context = await browser.newContext({ hasTouch: touch, isMobile: touch, viewport: { width: touch ? 390 : 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.setContent(`<style>${css}</style><div id="root"></div>`);
    await page.addScriptTag({ content: result.outputFiles[0].text });
    const trigger = page.getByRole('button', { name: 'X', exact: true });
    await trigger.waitFor();
    if (!touch) await page.locator('.voice-message').hover();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.voice-attachment-remove')).opacity) > 0);
    const press = locator => touch ? locator.tap() : locator.click();
    await press(trigger);
    await press(page.getByRole('button', { name: 'cancel', exact: true }));
    await page.getByText('Remove attachment?').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.plays), 0);
    assert.equal(await page.evaluate(() => window.deletes), 0);
    await press(trigger);
    await press(page.getByRole('button', { name: 'confirm', exact: true }));
    await page.getByText('Remove attachment?').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.deletes), 1);
    assert.equal(await page.evaluate(() => window.plays), 0);
    if (!touch) {
      // A touchscreen laptop still uses mouse-hover behavior by default.
      await trigger.evaluate(el => el.blur());
      await page.mouse.move(1200, 700);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.voice-attachment-remove')).opacity === '0');
      // Actual touch input wins even if the device reports a primary fine pointer.
      await page.locator('.voice-message').evaluate(el => { el.dataset.pointer = 'touch'; });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.voice-attachment-remove')).opacity === '1');
      await trigger.focus();
      await page.keyboard.press('Enter');
      const cancel = page.getByRole('button', { name: 'cancel', exact: true });
      await cancel.focus();
      await page.keyboard.press('Enter');
      await page.getByText('Remove attachment?').waitFor({ state: 'hidden' });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
