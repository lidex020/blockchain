'use strict';

const net = require('node:net');
const {
  decodeRequest,
  decodeVarint,
  encodeResponse,
} = require('./protobuf');

function parseListenAddress(value) {
  const address = new URL(String(value ?? 'tcp://127.0.0.1:26658'));
  const host = address.hostname.replace(/^\[|\]$/g, '');
  if (address.protocol !== 'tcp:' || !host || !address.port) {
    throw new Error('ABCI listen address must be tcp://host:port');
  }
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('ABCI socket transport is unauthenticated and must bind to the IPv4 or IPv6 loopback address');
  }
  return { host, port: Number(address.port) };
}

class ABCISocketServer {
  constructor({ application, listen = 'tcp://127.0.0.1:26658', maxMessageBytes = 64 * 1024 * 1024 }) {
    if (!application) throw new TypeError('an ABCI application is required');
    this.application = application;
    this.listen = parseListenAddress(listen);
    this.maxMessageBytes = maxMessageBytes;
    this.connections = new Set();
    this.server = net.createServer((socket) => this.accept(socket));
  }

  accept(socket) {
    this.connections.add(socket);
    socket.setNoDelay(true);
    socket.on('close', () => this.connections.delete(socket));
    socket.on('error', () => this.connections.delete(socket));
    let buffered = Buffer.alloc(0);
    let requestQueue = Promise.resolve();

    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length) {
        let frame;
        try {
          frame = decodeVarint(buffered, 0);
        } catch (error) {
          socket.destroy(error);
          return;
        }
        if (!frame) return;
        if (frame.value > this.maxMessageBytes) {
          socket.destroy(new Error('ABCI request exceeds the configured frame limit'));
          return;
        }
        if (buffered.length < frame.bytes + frame.value) {
          if (buffered.length > this.maxMessageBytes + frame.bytes) {
            socket.destroy(new Error('ABCI request exceeds the configured frame limit'));
          }
          return;
        }
        const payload = buffered.subarray(frame.bytes, frame.bytes + frame.value);
        buffered = buffered.subarray(frame.bytes + frame.value);
        requestQueue = requestQueue.then(async () => {
          const request = decodeRequest(payload);
          const response = await this.application.dispatch(request);
          if (!socket.destroyed) socket.write(encodeResponse(response));
        }).catch((error) => {
          if (socket.destroyed) return;
          try {
            socket.write(encodeResponse({ exception: { error: String(error.message ?? error) } }));
          } finally {
            socket.end();
          }
        });
      }
    });
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.listen.port, this.listen.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    return this.server.address();
  }

  async close() {
    for (const socket of this.connections) socket.end();
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

module.exports = { ABCISocketServer, parseListenAddress };
