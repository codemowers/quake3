import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import test from 'node:test';
import {WebSocket} from 'ws';
import {DatagramGateway} from '../gateway/gateway.js';

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...arguments_) => resolve(arguments_));
    emitter.once('error', reject);
  });
}

test('forwards one binary WebSocket message as one UDP datagram and returns the reply', {timeout: 5000}, async (t) => {
  const udp = dgram.createSocket('udp4');
  t.after(() => udp.close());
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  udp.on('message', (packet, peer) => udp.send(Buffer.concat([Buffer.from('reply:'), packet]), peer.port, peer.address));

  const gateway = new DatagramGateway({
    host: '127.0.0.1',
    targetHost: '127.0.0.1',
    targetPort: udp.address().port,
    idleTimeoutMs: 10_000
  });
  await gateway.start();
  t.after(() => gateway.stop());

  const webSocket = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/ws`, 'binary');
  t.after(() => webSocket.terminate());
  await once(webSocket, 'open');
  webSocket.send(Buffer.from('quake'));
  const [reply, isBinary] = await once(webSocket, 'message');

  assert.equal(isBinary, true);
  assert.equal(reply.toString(), 'reply:quake');

  webSocket.close();
  await once(webSocket, 'close');
});

for (const asynchronous of [false, true]) {
  test(`returns HTTP 500 after a ${asynchronous ? 'rejected promise' : 'thrown error'} and keeps serving`, {timeout: 5000}, async (t) => {
    const failure = new Error('private failure details');
    const log = t.mock.method(console, 'error', () => {});
    const gateway = new DatagramGateway({
      host: '127.0.0.1',
      onRequest(request, response) {
        if (request.url === '/ok') return response.writeHead(200).end('ok');
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      }
    });
    t.after(() => gateway.stop());
    await gateway.start();
    const origin = `http://127.0.0.1:${gateway.address().port}`;
    const response = await fetch(origin);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), 'Internal server error\n');
    assert.equal(log.mock.calls[0].arguments[1], failure);
    const healthy = await fetch(`${origin}/ok`);
    assert.equal(healthy.status, 200);
    assert.equal(await healthy.text(), 'ok');
  });
}

test('rejects WebSocket upgrades while unready and accepts them when ready', {timeout: 5000}, async (t) => {
  let ready = false;
  const gateway = new DatagramGateway({host: '127.0.0.1', ready: () => ready});
  await gateway.start();
  t.after(() => gateway.stop());
  const response = await fetch(`http://127.0.0.1:${gateway.healthServer.address().port}/healthz`);
  assert.equal(response.status, 503);
  const publicResponse = await fetch(`http://127.0.0.1:${gateway.address().port}/healthz`);
  assert.equal(publicResponse.status, 404);
  const url = `ws://127.0.0.1:${gateway.address().port}/ws`;
  const rejected = new WebSocket(url);
  t.after(() => rejected.terminate());
  await new Promise((resolve, reject) => {
    rejected.once('open', () => reject(new Error('Unready gateway accepted an upgrade')));
    rejected.once('error', reject);
    rejected.once('unexpected-response', (request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
  }).then((status) => assert.equal(status, 503));
  // Aborting a rejected handshake emits an expected error.
  rejected.removeAllListeners('error');
  rejected.once('error', (error) => assert.match(error.message, /closed before the connection was established/));
  rejected.terminate();

  ready = true;
  const healthy = await fetch(`http://127.0.0.1:${gateway.healthServer.address().port}/healthz`);
  assert.equal(healthy.status, 200);
  const accepted = new WebSocket(url);
  t.after(() => accepted.terminate());
  await once(accepted, 'open');
  accepted.close();
  await once(accepted, 'close');
});

test('internal Prometheus gauge tracks open WebSockets through close and disconnect', {timeout: 5000}, async (t) => {
  const gateway = new DatagramGateway({host: '127.0.0.1'});
  await gateway.start();
  t.after(() => gateway.stop());
  const metricsUrl = `http://127.0.0.1:${gateway.healthServer.address().port}/metrics`;
  const assertSessions = async (count) => {
    const response = await fetch(metricsUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
    const text = await response.text();
    assert.match(text, /# TYPE quake3_open_websocket_sessions gauge\n/);
    assert.match(text, new RegExp(`\nquake3_open_websocket_sessions ${count}\n$`));
  };
  await assertSessions(0);
  const clients = [];
  for (let index = 0; index < 2; index++) {
    const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/ws`);
    clients.push(client);
    t.after(() => client.terminate());
    await once(client, 'open');
    await assertSessions(index + 1);
  }
  const serverClients = [...gateway.clients];
  let closed = once(serverClients[0], 'close');
  clients[0].close();
  await closed;
  await assertSessions(1);
  closed = once(serverClients[1], 'close');
  clients[1].terminate();
  await closed;
  await assertSessions(0);
  const publicResponse = await fetch(`http://127.0.0.1:${gateway.address().port}/metrics`);
  assert.equal(publicResponse.status, 404);
});

test('browser policy binds identity and removes desktop-only menu controls', () => {
  const page = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const policy = fs.readFileSync(new URL('../engine/patches/ioq3-web-policy.diff', import.meta.url), 'utf8');
  const serverConfig = fs.readFileSync(new URL('../engine/server.cfg', import.meta.url), 'utf8');
  const nginx = fs.readFileSync(new URL('../web/nginx.conf', import.meta.url), 'utf8');

  assert.match(page, /json\('\/auth\/me'\)/);
  assert.match(page, /String\(identity\?\.subject \|\| 'Player'\)/);
  assert.match(page, /`set web_identity_name "\$\{playerName\}"`/);
  assert.match(page, /'bind F9 togglemenu'/);
  assert.match(page, /'bind MOUSE2 \+moveup'/);
  assert.match(page, /'set r_vertexLight 1'/);
  assert.match(page, /'set cg_shadows 0'/);
  assert.match(page, /'set r_overBrightBits 1'/);
  assert.match(page, /'set r_ext_multisample 4'/);
  assert.match(page, /'set r_ext_texture_filter_anisotropic 1'/);
  assert.match(page, /'set r_ext_max_anisotropy 16'/);
  assert.match(page, /'set r_arb_vertex_array_object 1'/);
  assert.match(page, /'set r_simpleMipMaps 1'/);
  const bytesHelper = page.slice(page.indexOf('const bytes ='), page.indexOf('const quakePlayerName ='));
  assert.match(bytesHelper, /cache: url\.startsWith\('\/qvm\/'\) \? 'no-store' : 'default'/);
  assert.match(page, /writeFile\(`\/\$\{game\}\/autoexec\.cfg`, startupConfig\)/);
  assert.doesNotMatch(page, /arguments:/);
  assert.doesNotMatch(page, /'r_hdr'/);
  assert.doesNotMatch(page, /'r_postProcess'/);
  assert.doesNotMatch(page, /'r_autoExposure'/);
  assert.match(page, /'set r_picmip 0'/);
  assert.match(page, /'set r_lodbias -2'/);
  assert.match(page, /'set r_facePlaneCull 1'/);
  assert.match(page, /'set r_znear 4'/);
  assert.match(page, /'set r_stencilbits 8'/);
  assert.match(page, /'set r_fullscreen 0'/);
  assert.match(page, /width: 100vw !important/);
  assert.match(page, /Downloading \$\{url\}/);
  assert.match(policy, /Cvar_VariableString\( "web_identity_name" \)/);
  assert.match(policy, /CVAR_USERINFO \| CVAR_ROM/);
  assert.match(policy, /Cbuf_AddText\( "connect 127\.0\.0\.1:27960\\n" \)/);
  assert.doesNotMatch(policy, /stage > 1 && hasLightmapStage/);
  assert.match(policy, /precision highp float/);
  assert.match(policy, /-sMIN_WEBGL_VERSION=2/);
  assert.match(policy, /-\s*Menu_AddItem\( &s_graphicsoptions\.menu, \( void \* \) &s_graphicsoptions\.lighting \)/);
  assert.match(policy, /-\s*Menu_AddItem\( &s_playersettings\.menu, &s_playersettings\.name \)/);
  assert.match(policy, /-\s*Menu_AddItem\( &s_graphicsoptions\.menu, \( void \* \) &s_graphicsoptions\.mode \)/);
  assert.match(policy, /-\s*Menu_AddItem\( &s_main\.menu,\s*&s_main\.exit \)/);
  assert.match(policy, /-\s*Menu_AddItem\( &s_ingame\.menu, &s_ingame\.quit \)/);
  assert.match(policy, /-\s*Menu_AddItem\( &setupMenuInfo\.menu, &setupMenuInfo\.cdkey \)/);
  assert.match(policy, /-\s*Menu_AddItem\( &setupMenuInfo\.menu, &setupMenuInfo\.setupsystem \)/);
  assert.match(policy, /-\s*if\( !uis\.demoversion && !ui_cdkeychecked\.integer \)/);
  assert.match(serverConfig, /seta sv_pure 0/);
  assert.match(nginx, /Cache-Control "no-store" always/);
});
