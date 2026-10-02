import process from 'node:process';
import {DatagramGateway} from './gateway.js';
import {createAuthentication} from './auth.js';

const backendHost = process.env.Q3_BACKEND_HOST || 'quake3-server';
// Static assets, PAKs, and QVMs are served by the Nginx front end. This process
// is only the OpenID Connect relying party and the WebSocket-to-UDP bridge.
async function requestHandler(request, response) {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname === '/auth/game-info') {
    response.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
    response.end(JSON.stringify({passwordRequired: process.env.Q3_PASSWORD_REQUIRED === 'true'}));
    return;
  }
  if (await authentication.handle(request, response)) return;
  if (url.pathname === '/auth/check') {
    const status = authentication.authorizeUpgrade(request) ? 204 : 401;
    response.writeHead(status, {'cache-control': 'no-store'}).end();
    return;
  }
  response.writeHead(404, {'content-type': 'text/plain', 'cache-control': 'no-store'}).end('Not found\n');
}

const authentication = await createAuthentication();

const gateway = new DatagramGateway({
  host: '::',
  port: 8081,
  healthPort: 8082,
  targetHost: backendHost,
  targetPort: 27961,
  authorizeUpgrade: (request) => authentication.authorizeUpgrade(request),
  onRequest: requestHandler
});

await gateway.start();
console.log(`OIDC endpoints and WebSocket gateway listening on 8081/tcp`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  authentication.close();
  await gateway.stop();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
