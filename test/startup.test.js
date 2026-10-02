import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

for (const passwordRequired of [false, true]) {
test(`browser startup loads game files and handles passwordRequired=${passwordRequired}`, async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const configuration = JSON.parse(await readFile(new URL('../web/client-config.json', import.meta.url)));
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace("import {createConnectionRecovery} from './reconnect.js';", '')
    .replace("const createEngine = (await import('/ioquake3.js')).default;", '');
  const files = new Map();
  const handlers = new Map();
  const dependencies = new Set();
  const events = [];
  const pageEvents = new Map();
  const element = {addEventListener() {}, getContext() {}, remove() {}, focus() {}};
  const input = {...element, value: 'testpassword123'};
  const form = {...element, addEventListener: (event, callback) => {
    assert.equal(event, 'submit');
    queueMicrotask(() => callback({preventDefault() {}}));
  }};
  const document = {querySelector: (selector) => selector === '#game-password' ? form
    : selector === '#game-password-input' ? input : {...element}};
  const payload = new Uint8Array([1, 2, 3]);
  let started = false;
  const createEngine = async (options) => {
    const engine = Object.assign(options, {
      FS: {mkdirTree() {}, writeFile: (path, data) => files.set(path, data)},
      addRunDependency: (name) => dependencies.add(name),
      removeRunDependency: (name) => dependencies.delete(name),
      _CL_WebDisconnect: () => events.push('disconnect-game')
    });
    // Emscripten does not await preRun promises. The dependency must be
    // registered synchronously, while websocket is still just configuration.
    assert.equal(engine.websocket.on, undefined);
    const loading = engine.preRun[0](engine);
    // Navigating away while still loading must not call into uninitialized WASM.
    pageEvents.get('pagehide')();
    assert.deepEqual(events.splice(0), ['close-recovery']);
    assert.ok(dependencies.has('game-files'));
    await loading;
    assert.equal(dependencies.size, 0);
    for (const file of configuration.baseq3.files) {
      const name = file.src.slice(file.src.lastIndexOf('/') + 1);
      assert.deepEqual(files.get(`${file.dst}/${name}`), payload);
    }
    assert.match(files.get('/baseq3/autoexec.cfg'), /set net_enabled 1/);
    assert.ok(files.get('/baseq3/autoexec.cfg').includes(`set password "${passwordRequired ? 'testpassword123' : ''}"`));
    if (passwordRequired) assert.equal(input.value, '');
    engine.websocket.on = (event, callback) => handlers.set(event, callback);
    engine.onRuntimeInitialized();
    assert.deepEqual([...handlers.keys()].sort(), ['close', 'error', 'open']);
    started = true;
    return engine;
  };
  const fetch = async (url) => {
    if (url === '/client-config.json') return Response.json(configuration);
    if (url === '/auth/me') return Response.json({authenticated: false});
    if (url === '/auth/game-info') return Response.json({passwordRequired});
    assert.ok(configuration.baseq3.files.some((file) => file.src === url));
    return new Response(payload);
  };
  const createConnectionRecovery = () => ({
    disconnected: () => events.push('disconnected'),
    connected: () => events.push('connected'),
    close: () => events.push('close-recovery')
  });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('document', 'location', 'addEventListener', 'fetch',
    'createEngine', 'createConnectionRecovery', source)(
    document, {protocol: 'https:', host: 'quake.example'},
    (name, callback) => pageEvents.set(name, callback), fetch,
    createEngine, createConnectionRecovery);
  assert.ok(started);
  handlers.get('error')();
  handlers.get('close')();
  handlers.get('open')();
  assert.deepEqual(events, ['disconnected', 'disconnected', 'connected']);
  events.length = 0;
  pageEvents.get('pagehide')();
  assert.deepEqual(events, ['close-recovery', 'disconnect-game']);
});
}
