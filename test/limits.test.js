import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, ConnectionCounter, clientIp, originAllowed } from '../server/limits.js';

test('RateLimiter: burst, esaurimento e ricarica', () => {
  let t = 0;
  const rl = new RateLimiter(1, 3, () => t);
  assert.ok(rl.take('a') && rl.take('a') && rl.take('a'));
  assert.equal(rl.take('a'), false);
  assert.ok(rl.take('b')); // chiavi indipendenti
  t += 2000;
  assert.ok(rl.take('a'));
  t += 10_000;
  rl.sweep();
  assert.equal(rl.buckets.size, 0);
});

test('ConnectionCounter: tetto per chiave', () => {
  const c = new ConnectionCounter(2);
  assert.ok(c.acquire('x') && c.acquire('x'));
  assert.equal(c.acquire('x'), false);
  c.release('x');
  assert.ok(c.acquire('x'));
});

test('clientIp: CF-Connecting-IP solo se la connessione è loopback', () => {
  const mk = (remoteAddress, h) => ({ socket: { remoteAddress }, headers: h });
  assert.equal(clientIp(mk('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })), '1.2.3.4');
  assert.equal(clientIp(mk('127.0.0.1', {})), '127.0.0.1');
  assert.equal(clientIp(mk('9.9.9.9', { 'cf-connecting-ip': '1.2.3.4' })), '9.9.9.9');
});

test('originAllowed: stesso host, assente o in lista', () => {
  const r = (origin) => ({ headers: { host: 'tracker.swordrpg.com', origin } });
  assert.ok(originAllowed(r('https://tracker.swordrpg.com')));
  assert.ok(originAllowed(r(undefined)));
  assert.equal(originAllowed(r('https://evil.example')), false);
  assert.equal(originAllowed(r('not a url')), false);
  assert.ok(originAllowed(r('https://altro.it'), ['https://altro.it']));
});
