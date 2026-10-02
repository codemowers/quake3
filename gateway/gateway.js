import dgram from 'node:dgram';
import http from 'node:http';
import {WebSocket, WebSocketServer} from 'ws';

const DEFAULT_MAX_PACKET_BYTES = 65_535;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export class DatagramGateway {
  constructor(options = {}) {
    this.host = options.host || '::';
    this.port = options.port ?? 0;
    this.healthPort = options.healthPort ?? 0;
    this.path = options.path || '/ws';
    this.targetHost = options.targetHost || '127.0.0.1';
    this.targetPort = options.targetPort || 27961;
    this.maxPacketBytes = options.maxPacketBytes || DEFAULT_MAX_PACKET_BYTES;
    this.idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
    this.onRequest = options.onRequest;
    this.ready = options.ready || (() => true);
    this.authorizeUpgrade = options.authorizeUpgrade || (() => true);
    this.clients = new Set();

    this.webSockets = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: this.maxPacketBytes
    });
    this.server = http.createServer(async (request, response) => {
      if (this.onRequest) {
        try {
          await this.onRequest(request, response);
        } catch (error) {
          console.error('HTTP request failed:', error);
          if (response.headersSent) {
            response.destroy();
          } else {
            response.writeHead(500, {'content-type': 'text/plain', 'cache-control': 'no-store'});
            response.end('Internal server error\n');
          }
        }
        return;
      }
      response.writeHead(404).end();
    });
    this.healthServer = http.createServer((request, response) => {
      if (request.url === '/metrics') {
        const sessions = [...this.clients].filter((client) => client.readyState === WebSocket.OPEN).length;
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store'
        });
        response.end('# HELP quake3_open_websocket_sessions Open game WebSocket connections on this gateway.\n'
          + '# TYPE quake3_open_websocket_sessions gauge\n'
          + `quake3_open_websocket_sessions ${sessions}\n`);
        return;
      }
      if (request.url !== '/healthz') {
        response.writeHead(404).end();
        return;
      }
      const ready = this.server.listening && this.ready();
      response.writeHead(ready ? 200 : 503, {'content-type': 'application/json'});
      response.end(JSON.stringify({status: ready ? 'ready' : 'starting'}));
    });
    this.server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (!this.ready()) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      if (!this.authorizeUpgrade(request)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      if (pathname !== this.path && !(this.path === '/ws' && pathname === '/')) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.#connect(webSocket);
      });
    });
  }

  async start() {
    await Promise.all([[this.server, this.port], [this.healthServer, this.healthPort]].map(([server, port]) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, this.host, () => {
          server.off('error', reject);
          resolve();
        });
      })
    ));
    return this.address();
  }

  address() {
    return this.server.address();
  }

  async stop() {
    for (const webSocket of this.clients) webSocket.terminate();
    await Promise.all([
      new Promise((resolve) => this.webSockets.close(resolve)),
      ...[this.server, this.healthServer].map((server) => server.listening
        ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve())
    ]);
  }

  #connect(webSocket) {
    const udp = dgram.createSocket('udp4');
    let closed = false;
    let timer;
    this.clients.add(webSocket);

    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => webSocket.close(1000, 'Idle timeout'), this.idleTimeoutMs);
      timer.unref();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      this.clients.delete(webSocket);
      try {
        udp.close();
      } catch (error) {
        if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error;
      }
    };

    udp.on('message', (packet) => {
      refresh();
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(packet, {binary: true});
      }
    });
    udp.on('error', () => {
      webSocket.close(1011, 'UDP transport failed');
      close();
    });
    webSocket.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const packet = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (packet.length > this.maxPacketBytes) {
        webSocket.close(1009, 'Packet too large');
        return;
      }
      refresh();
      udp.send(packet, this.targetPort, this.targetHost, (error) => {
        if (error) {
          webSocket.close(1011, 'UDP transport failed');
          close();
        }
      });
    });
    webSocket.on('close', close);
    webSocket.on('error', close);
    refresh();
  }
}
