// Independent thread samples this process's own resident memory while scoring
// blocks the main JS event loop. This reports an observed peak, not a kernel HWM.
let timer: ReturnType<typeof setInterval> | undefined;
let cells: BigInt64Array;
let previous = 0;
function sample() {
  const at = performance.now();
  const rss = BigInt(process.memoryUsage().rss);
  if (rss > Atomics.load(cells, 0)) Atomics.store(cells, 0, rss);
  Atomics.add(cells, 1, 1n);
  if (previous) {
    const gap = BigInt(Math.round((at - previous) * 1000));
    if (gap > Atomics.load(cells, 2)) Atomics.store(cells, 2, gap);
  }
  previous = at;
}
self.onmessage = (event: MessageEvent) => {
  if (event.data.type === 'start') {
    cells = new BigInt64Array(event.data.buffer);
    sample();
    timer = setInterval(sample, event.data.intervalMs);
    self.postMessage({ type: 'ready' });
  } else if (event.data.type === 'stop') {
    if (timer !== undefined) clearInterval(timer);
    sample();
    self.postMessage({ type: 'stopped' });
  }
};
