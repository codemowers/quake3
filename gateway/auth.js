import crypto from 'node:crypto';
import * as oidc from 'openid-client';

const SESSION_COOKIE = '__Host-q3session';
const TRANSACTION_COOKIE = '__Host-q3login';

export async function createAuthentication(environment = process.env) {
  const configured = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI', 'OIDC_SESSION_SECRET'].some((name) => environment[name]);
  return configured ? OpenIdAuthentication.create(environment) : new AnonymousAuthentication();
}

class AnonymousAuthentication {
  authorizeUpgrade() { return true; }
  close() {}

  async handle(request, response) {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/auth/me') {
      response.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
      response.end(`${JSON.stringify({
        subject: `Anonymous-${crypto.randomBytes(4).toString('hex')}`,
        authenticated: false
      })}\n`);
      return true;
    }
    if (pathname === '/auth/login' || pathname === '/auth/logout') {
      response.writeHead(303, {location: '/', 'cache-control': 'no-store'}).end();
      return true;
    }
    return false;
  }
}

function cookies(request) {
  const result = new Map();
  for (const part of (request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return result;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class OpenIdAuthentication {
  #cleanupTimer;

  static async create(environment = process.env) {
    const issuer = environment.OIDC_ISSUER_URL;
    const clientId = environment.OIDC_CLIENT_ID;
    const clientSecret = environment.OIDC_CLIENT_SECRET;
    const redirectUri = environment.OIDC_REDIRECT_URI;
    const sessionSecret = environment.OIDC_SESSION_SECRET;
    for (const [name, value] of Object.entries({
      OIDC_ISSUER_URL: issuer,
      OIDC_CLIENT_ID: clientId,
      OIDC_CLIENT_SECRET: clientSecret,
      OIDC_REDIRECT_URI: redirectUri,
      OIDC_SESSION_SECRET: sessionSecret
    })) {
      if (!value) throw new Error(`${name} is required`);
    }
    if (Buffer.byteLength(sessionSecret) < 32) {
      throw new Error('OIDC_SESSION_SECRET must contain at least 32 bytes');
    }
    const callback = new URL(redirectUri);
    if (callback.pathname !== '/auth/callback') {
      throw new Error('OIDC_REDIRECT_URI must end with /auth/callback');
    }
    const configuration = await oidc.discovery(new URL(issuer), clientId, clientSecret);
    return new OpenIdAuthentication({
      configuration,
      providerName: environment.OIDC_IDP_DISPLAY_NAME || 'OpenID',
      redirectUri: callback.href,
      origin: callback.origin,
      secret: sessionSecret,
      sessionTtlMs: Number.parseInt(environment.OIDC_SESSION_TTL_SECONDS || '28800', 10) * 1000
    });
  }

  constructor(options) {
    this.configuration = options.configuration;
    this.providerName = options.providerName || 'OpenID';
    this.redirectUri = options.redirectUri;
    this.origin = options.origin;
    this.secret = Buffer.from(options.secret);
    this.sessionTtlMs = options.sessionTtlMs;
    this.transactions = new Map();
    this.sessions = new Map();
    this.#cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const records of [this.transactions, this.sessions]) {
        for (const [id, record] of records) {
          if (record.expiresAt <= now) records.delete(id);
        }
      }
    }, 60_000);
    this.#cleanupTimer.unref();
  }

  close() {
    clearInterval(this.#cleanupTimer);
  }

  #sign(value) {
    return base64url(crypto.createHmac('sha256', this.secret).update(value).digest());
  }

  #encode(value) {
    return `${value}.${this.#sign(value)}`;
  }

  #decode(value) {
    if (!value) return undefined;
    const separator = value.lastIndexOf('.');
    if (separator < 1) return undefined;
    const id = value.slice(0, separator);
    return safeEqual(value.slice(separator + 1), this.#sign(id)) ? id : undefined;
  }

  #cookie(name, value, maxAge) {
    return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  }

  session(request) {
    const id = this.#decode(cookies(request).get(SESSION_COOKIE));
    const session = id && this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  authorizeUpgrade(request) {
    return Boolean(this.session(request));
  }

  async handle(request, response) {
    const url = new URL(request.url || '/', this.origin);
    if (url.pathname === '/auth/login') {
      const id = base64url(crypto.randomBytes(24));
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      this.transactions.set(id, {
        state,
        nonce,
        verifier,
        popup: url.searchParams.get('popup') === '1',
        expiresAt: Date.now() + 10 * 60_000
      });
      const authorizationUrl = oidc.buildAuthorizationUrl(this.configuration, {
        redirect_uri: this.redirectUri,
        scope: 'openid',
        response_type: 'code',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256'
      });
      response.writeHead(302, {
        location: authorizationUrl.href,
        'set-cookie': this.#cookie(TRANSACTION_COOKIE, this.#encode(id), 600),
        'cache-control': 'no-store'
      }).end();
      return true;
    }

    if (url.pathname === '/auth/callback') {
      const id = this.#decode(cookies(request).get(TRANSACTION_COOKIE));
      const transaction = id && this.transactions.get(id);
      if (id) this.transactions.delete(id);
      if (!transaction || transaction.expiresAt <= Date.now()) {
        response.writeHead(400, {'content-type': 'text/plain'}).end('Login transaction expired.\n');
        return true;
      }
      let tokens;
      try {
        tokens = await oidc.authorizationCodeGrant(this.configuration, url, {
          pkceCodeVerifier: transaction.verifier,
          expectedState: transaction.state,
          expectedNonce: transaction.nonce,
          idTokenExpected: true
        });
      } catch (error) {
        const rejected = error instanceof oidc.AuthorizationResponseError ||
          (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant') ||
          (error instanceof oidc.ClientError && [
            'OAUTH_INVALID_RESPONSE',
            'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
            'OAUTH_JWT_TIMESTAMP_CHECK_FAILED',
            'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED'
          ].includes(error.code));
        if (!rejected) throw error;
        response.writeHead(401, {
          'content-type': 'text/plain',
          'cache-control': 'no-store'
        }).end('Authentication failed.\n');
        return true;
      }
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('The ID token has no subject claim');
      const sessionId = base64url(crypto.randomBytes(32));
      const tokenExpiry = Number.isFinite(claims.exp) ? claims.exp * 1000 : Infinity;
      const expiresAt = Math.min(Date.now() + this.sessionTtlMs, tokenExpiry);
      this.sessions.set(sessionId, {subject: claims.sub, expiresAt});
      const sessionHeaders = {
        'set-cookie': [
          this.#cookie(SESSION_COOKIE, this.#encode(sessionId), Math.floor((expiresAt - Date.now()) / 1000)),
          this.#cookie(TRANSACTION_COOKIE, '', 0)
        ],
        'cache-control': 'no-store'
      };
      if (transaction.popup) {
        const nonce = base64url(crypto.randomBytes(24));
        response.writeHead(200, {
          ...sessionHeaders,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
          'referrer-policy': 'no-referrer'
        }).end(`<!doctype html><title>Signed in</title><p>Signed in. You can close this window and return to the game.</p><script nonce="${nonce}">window.close();</script>`);
      } else {
        response.writeHead(303, {...sessionHeaders, location: '/'}).end();
      }
      return true;
    }

    if (url.pathname === '/auth/logout') {
      const id = this.#decode(cookies(request).get(SESSION_COOKIE));
      if (id) this.sessions.delete(id);
      response.writeHead(303, {
        location: '/auth/login',
        'set-cookie': this.#cookie(SESSION_COOKIE, '', 0),
        'cache-control': 'no-store'
      }).end();
      return true;
    }

    if (url.pathname === '/auth/me') {
      const session = this.session(request);
      if (!session) {
        response.writeHead(401, {'content-type': 'application/json', 'cache-control': 'no-store'}).end('{"error":"authentication required"}\n');
      } else {
        const body = `${JSON.stringify({subject: session.subject, providerName: this.providerName, authenticated: true})}\n`;
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store'
        }).end(body);
      }
      return true;
    }
    return false;
  }
}
