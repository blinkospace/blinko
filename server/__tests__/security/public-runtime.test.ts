import { test, expect } from 'bun:test';
import http from 'node:http';

test('runtime connects to the validated pinned address and preserves the original HTTP host', async () => {
  const server = http.createServer((req, res) => { res.end(req.headers.host); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as any).port;
  let called = false;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://blinko-lookup-fixture.invalid:${port}/`, {
        agent: false,
        lookup: (_host, opts: any, callback: any) => {
          called = true;
          if (opts?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
          else callback(null, '127.0.0.1', 4);
        },
      }, res => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve(data)); });
      const timer = setTimeout(() => req.destroy(new Error('Pinned connection timed out')), 2000);
      req.on('close', () => clearTimeout(timer)); req.on('error', reject);
    });
    expect(called).toBe(true);
    expect(body).toBe(`blinko-lookup-fixture.invalid:${port}`);
  } finally { server.close(); }
});
