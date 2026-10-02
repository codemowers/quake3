import assert from 'node:assert/strict';
import test from 'node:test';
import * as oidc from 'openid-client';
import crypto from 'node:crypto';
import {createAuthentication, OpenIdAuthentication} from '../gateway/auth.js';

for (const popup of [false, true]) {
  test(`successful ${popup ? 'popup' : 'page'} login restores an opaque session without exposing tokens`, async (t) => {
    const configuration = new oidc.Configuration({
      issuer: 'https://idp.example',
      authorization_endpoint: 'https://idp.example/authorize',
      token_endpoint: 'https://idp.example/token'
    }, 'quake3', {client_secret: 'client-secret', id_token_signed_response_alg: 'HS256'});
    const options = {configuration, origin: 'https://quake.example',
      redirectUri: 'https://quake.example/auth/callback', secret: 'test-secret', sessionTtlMs: 60_000};
    const authentication = new OpenIdAuthentication(options);
    t.after(() => authentication.close());
    const response = {
      writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
      end(body) { this.body = body; }
    };
    await authentication.handle({url: popup ? '/auth/login?popup=1' : '/auth/login', headers: {}}, response);
    const authorization = new URL(response.headers.location);
    const cookie = response.headers['set-cookie'].split(';')[0];
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = `${encode({alg: 'HS256'})}.${encode({
      iss: 'https://idp.example', aud: 'quake3', sub: 'player',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: authorization.searchParams.get('nonce')
    })}`;
    const token = `${payload}.${crypto.createHmac('sha256', 'client-secret').update(payload).digest('base64url')}`;
    configuration[oidc.customFetch] = async () => new Response(JSON.stringify({
      access_token: 'private-access-token', token_type: 'Bearer', id_token: token
    }), {headers: {'content-type': 'application/json'}});
    await authentication.handle({
      url: `/auth/callback?code=code&state=${authorization.searchParams.get('state')}`,
      headers: {cookie}
    }, response);
    assert.equal(response.status, popup ? 200 : 303);
    if (popup) {
      assert.match(response.body, /window.close\(\)/);
      assert.equal(response.headers.location, undefined);
      assert.match(response.headers['content-security-policy'], /script-src 'nonce-/);
      assert.ok(!response.body.includes(token));
      assert.ok(!response.body.includes('private-access-token'));
    } else {
      assert.equal(response.headers.location, '/');
    }
    const sessionCookie = response.headers['set-cookie'][0].split(';')[0];
    assert.equal(authentication.session({headers: {cookie: sessionCookie}}).subject, 'player');
    const restarted = new OpenIdAuthentication(options);
    t.after(() => restarted.close());
    assert.equal(restarted.authorizeUpgrade({headers: {cookie: sessionCookie}}), false);
    await restarted.handle({url: '/auth/me', headers: {cookie: sessionCookie}}, response);
    assert.equal(response.status, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
  });
}

test('missing OIDC configuration allows anonymous play without cookies or login redirects', async (t) => {
  const authentication = await createAuthentication({OIDC_CLIENT_SECRET: ''});
  t.after(() => authentication.close());
  assert.equal(authentication.authorizeUpgrade({headers: {}}), true);
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(body) { this.body = body; }
  };
  assert.equal(await authentication.handle({url: '/auth/me'}, response), true);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  const identity = JSON.parse(response.body);
  assert.equal(identity.authenticated, false);
  assert.match(identity.subject, /^Anonymous-[a-f0-9]{8}$/);
  await authentication.handle({url: '/auth/login'}, response);
  assert.equal(response.headers.location, '/');
  assert.equal(await authentication.handle({url: '/unrelated'}, response), false);
});

test('partial OIDC configuration fails closed instead of selecting anonymous mode', async () => {
  const configuration = {
    OIDC_ISSUER_URL: 'https://idp.example',
    OIDC_CLIENT_ID: 'quake3',
    OIDC_CLIENT_SECRET: 'client-secret',
    OIDC_REDIRECT_URI: 'https://quake.example/auth/callback',
    OIDC_SESSION_SECRET: 'session-secret-with-at-least-32-bytes'
  };
  for (const name of Object.keys(configuration)) {
    await assert.rejects(createAuthentication({...configuration, [name]: ''}), new RegExp(`${name} is required`));
    await assert.rejects(createAuthentication({[name]: configuration[name]}), /is required/);
  }
  await assert.rejects(createAuthentication({...configuration, OIDC_SESSION_SECRET: 'short'}), /at least 32 bytes/);
});

test('periodically removes abandoned expired records and stops cleanup on close', (t) => {
  t.mock.timers.enable({apis: ['Date', 'setInterval'], now: 1000});
  const authentication = new OpenIdAuthentication({secret: 'test-secret'});
  t.after(() => authentication.close());
  for (const records of [authentication.transactions, authentication.sessions]) {
    records.set('expired', {expiresAt: 60_999});
    records.set('boundary', {expiresAt: 61_000});
    records.set('active', {expiresAt: 61_001});
  }
  t.mock.timers.tick(60_000);
  for (const records of [authentication.transactions, authentication.sessions]) {
    assert.deepEqual([...records.keys()], ['active']);
  }
  authentication.close();
  t.mock.timers.tick(60_000);
  assert.equal(authentication.transactions.size, 1);
  assert.equal(authentication.sessions.size, 1);
});

for (const scenario of ['denied', 'state mismatch', 'invalid configuration']) {
  test(`OIDC callback handles ${scenario} without hiding programming errors`, async (t) => {
    const authentication = new OpenIdAuthentication({
      configuration: new oidc.Configuration({
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/authorize',
        token_endpoint: 'https://idp.example/token'
      }, 'quake3', 'client-secret'),
      origin: 'https://quake.example',
      redirectUri: 'https://quake.example/auth/callback',
      secret: 'test-secret',
      sessionTtlMs: 60_000
    });
    t.after(() => authentication.close());
    const response = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        return this;
      },
      end() {}
    };
    await authentication.handle({url: '/auth/login', headers: {}}, response);
    assert.equal(new URL(response.headers.location).searchParams.get('scope'), 'openid');
    const cookie = response.headers['set-cookie'].split(';')[0];
    const state = new URL(response.headers.location).searchParams.get('state');
    const request = {
      url: scenario === 'state mismatch'
        ? '/auth/callback?code=test&state=wrong'
        : `/auth/callback?error=access_denied&state=${state}`,
      headers: {cookie}
    };
    if (scenario === 'invalid configuration') {
      authentication.configuration = undefined;
      await assert.rejects(authentication.handle(request, response), TypeError);
    } else {
      await authentication.handle(request, response);
      assert.equal(response.status, 401);
    }
    assert.equal(authentication.transactions.size, 0);
    assert.equal(authentication.sessions.size, 0);
  });
}
