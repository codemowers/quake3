import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {createConnectionRecovery} from '../web/reconnect.js';

test('gateway restart prompts for login, then reconnects the existing engine once authentication returns', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let status = 401;
  let requests = 0;
  let reconnects = 0;
  let state;
  const recovery = createConnectionRecovery({
    identity: {authenticated: true, subject: 'player'},
    fetchIdentity: async () => {
      requests++;
      return new Response(JSON.stringify({subject: 'player'}), {status});
    },
    reconnect: () => reconnects++,
    onStatus: (value) => { state = value; }
  });
  t.after(() => recovery.close());
  recovery.disconnected();
  recovery.disconnected();
  await setImmediate();
  assert.equal(requests, 1);
  assert.equal(state, 'login');
  assert.equal(reconnects, 0);
  status = 200;
  t.mock.timers.tick(3000);
  await setImmediate();
  assert.equal(reconnects, 1);
  assert.equal(state, 'connecting');
  recovery.connected();
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.equal(state, 'connected');
  assert.equal(requests, 2);
});

test('gateway downtime retries without prompting for login or reloading', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let requests = 0;
  let reconnects = 0;
  const states = [];
  const recovery = createConnectionRecovery({
    identity: {authenticated: false},
    fetchIdentity: async () => {
      if (++requests === 1) throw new TypeError('Network failure');
      if (requests === 2) return new Response('', {status: 502});
      return new Response(JSON.stringify({subject: 'Anonymous-new', authenticated: false}));
    },
    reconnect: () => reconnects++,
    onStatus: (state) => states.push(state)
  });
  t.after(() => recovery.close());
  recovery.disconnected();
  await setImmediate();
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(3000);
    await setImmediate();
  }
  assert.equal(requests, 3);
  assert.equal(reconnects, 1);
  assert.ok(!states.includes('login'));
});

test('does not reconnect a game under a different signed-in identity', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let state;
  const recovery = createConnectionRecovery({
    identity: {authenticated: true, subject: 'original'},
    fetchIdentity: async () => new Response(JSON.stringify({subject: 'different'})),
    reconnect: () => assert.fail('must not reconnect with another identity'),
    onStatus: (value) => { state = value; }
  });
  t.after(() => recovery.close());
  recovery.disconnected();
  await setImmediate();
  assert.equal(state, 'login');
});

test('ignores a stale auth response once the connection has recovered', async (t) => {
  let resolve;
  let state;
  const recovery = createConnectionRecovery({
    identity: {authenticated: true, subject: 'player'},
    fetchIdentity: () => new Promise((done) => { resolve = done; }),
    reconnect: () => assert.fail('must not restart an already recovered connection'),
    onStatus: (value) => { state = value; }
  });
  t.after(() => recovery.close());
  recovery.disconnected();
  recovery.connected();
  resolve(new Response('', {status: 401}));
  await setImmediate();
  assert.equal(state, 'connected');
});
