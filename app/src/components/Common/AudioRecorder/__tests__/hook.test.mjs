import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const flush = () => new Promise(resolve => setImmediate(resolve));

// Exercise the hook with deterministic React/browser adapters. No microphone,
// network, browser permissions or real audio data are used.
function fixture({ permission, wakeRequest } = {}) {
  const slots = [], effects = [], timers = new Set(), recorders = [], locks = [];
  let cursor = 0, now = 0, microphoneCalls = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!slots[i] || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || deps.some((v, j) => v !== slots[i].deps[j])) {
        slots[i]?.cleanup?.();
        slots[i] = { deps };
        effects.push(() => { slots[i].cleanup = fn(); });
      }
    },
  };
  class Track extends EventTarget {
    readyState = 'live'; muted = false;
    stop() { this.readyState = 'ended'; }
  }
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm;codecs=opus';
    constructor(stream) { this.stream = stream; recorders.push(this); }
    start() { this.state = 'recording'; }
    data(text) { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
    pause() { this.state = 'paused'; this.onpause?.(); }
    resume() { this.state = 'recording'; this.onresume?.(); }
    stop() {
      if (this.state === 'inactive') throw new Error('duplicate stop');
      this.state = 'inactive';
      queueMicrotask(() => { this.data('FINAL'); this.onstop?.(); });
    }
  }
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const code = ts.transpileModule(readFileSync(new URL('../hook.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, require: name => { assert.equal(name, 'react'); return react; },
    Blob, MediaRecorder: Recorder, document,
    performance: { now: () => now },
    localStorage: { setItem() {} },
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    navigator: {
      mediaDevices: { getUserMedia: () => { microphoneCalls++; return permission || Promise.resolve(stream); } },
      wakeLock: { request: wakeRequest || (async () => {
        const lock = new EventTarget(); lock.released = false;
        lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
        locks.push(lock); return lock;
      }) },
    },
  });
  const render = () => { cursor = 0; const result = exports.default(); effects.splice(0).forEach(fn => fn()); return result; };
  return {
    render, stream, track, recorders, locks, timers,
    get microphoneCalls() { return microphoneCalls; },
    advance(ms) { now += ms; timers.forEach(fn => fn()); },
    visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test('rerenders and repeated starts retain the same recording and all chunks', async () => {
  const f = fixture();
  await f.render().startRecording();
  f.recorders[0].data('FIRST');
  f.advance(300_000);
  await f.render().startRecording();
  assert.equal(f.microphoneCalls, 1);
  assert.equal(f.render().recordingTime, 300);
  f.render().stopRecording();
  await Promise.resolve();
  assert.equal(await f.render().recordingBlob.text(), 'FIRSTFINAL');
  assert.equal(f.render().recordingTime, 300);
  assert.equal(f.timers.size, 0);
  f.unmount();
});

test('screen hide/show resumes an interrupted session, retains chunks and reacquires wake lock', async () => {
  const f = fixture();
  await f.render().startRecording();
  await flush();
  f.recorders[0].data('BEFORE');
  f.advance(5000);
  f.visible(false);
  f.recorders[0].pause();
  f.advance(60_000);
  assert.equal(f.render().recordingTime, 5);
  f.visible(true);
  await flush();
  assert.equal(f.recorders.length, 1);
  assert.equal(f.recorders[0].state, 'recording');
  assert.ok(f.locks[0].released);
  assert.equal(f.locks.length, 2);
  f.advance(2000);
  f.recorders[0].data('AFTER');
  f.render().stopRecording();
  await Promise.resolve();
  assert.equal(await f.render().recordingBlob.text(), 'BEFOREAFTERFINAL');
  assert.equal(f.render().recordingTime, 7);
});

test('unexpected browser stop keeps the result; returning does not restart recording', async () => {
  const f = fixture({ wakeRequest: async () => { throw new Error('not supported'); } });
  await f.render().startRecording();
  f.recorders[0].data('KEPT');
  f.visible(false);
  f.recorders[0].stop();
  await Promise.resolve();
  f.visible(true);
  await f.render().startRecording();
  assert.equal(f.microphoneCalls, 1);
  assert.equal(f.render().isRecording, false);
  assert.equal(await f.render().recordingBlob.text(), 'KEPTFINAL');
});

test('manual pause is not undone by visibility changes', async () => {
  const f = fixture();
  await f.render().startRecording();
  f.render().togglePauseResume();
  f.visible(false); f.visible(true);
  assert.equal(f.recorders[0].state, 'paused');
  f.unmount();
});

test('closing while microphone permission is pending prevents a late recording', async () => {
  let resolve;
  const f = fixture({ permission: new Promise(r => { resolve = r; }) });
  const first = f.render().startRecording();
  const second = f.render().startRecording();
  assert.equal(first, second);
  f.unmount(); resolve(f.stream);
  assert.equal(await first, undefined);
  assert.equal(f.recorders.length, 0);
  assert.equal(f.track.readyState, 'ended');
});

test('a wake lock granted after stop is released immediately', async () => {
  let resolve;
  const lock = { released: false, release: async () => { lock.released = true; } };
  const f = fixture({ wakeRequest: () => new Promise(r => { resolve = r; }) });
  await f.render().startRecording();
  f.render().stopRecording();
  resolve(lock);
  await flush();
  assert.equal(lock.released, true);
});

test('microphone mute freezes the clock without losing the session', async () => {
  const f = fixture();
  await f.render().startRecording(); f.advance(2000);
  f.track.muted = true; f.track.dispatchEvent(new Event('mute')); f.advance(50_000);
  assert.equal(f.render().recordingTime, 2);
  f.track.muted = false; f.track.dispatchEvent(new Event('unmute')); f.advance(3000);
  assert.equal(f.render().recordingTime, 5);
  f.unmount();
});
