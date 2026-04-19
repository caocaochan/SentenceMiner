import crypto from 'node:crypto';
import type net from 'node:net';
import type { IncomingMessage } from 'node:http';

export class WebSocketHub {
  #clients = new Set<net.Socket>();

  handleUpgrade(request: IncomingMessage, socket: net.Socket): void {
    const key = request.headers['sec-websocket-key'];
    if (!key || Array.isArray(key)) {
      socket.destroy();
      return;
    }

    const acceptValue = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptValue}`,
        '',
        '',
      ].join('\r\n'),
    );

    socket.on('close', () => this.#clients.delete(socket));
    socket.on('error', () => this.#clients.delete(socket));
    socket.on('end', () => this.#clients.delete(socket));
    socket.on('data', () => {
      // v1 is broadcast-only.
    });

    this.#clients.add(socket);
  }

  broadcastJson(payload: unknown): void {
    const frame = encodeTextFrame(JSON.stringify(payload));
    for (const client of this.#clients) {
      if (client.destroyed) {
        this.#clients.delete(client);
        continue;
      }

      client.write(frame);
    }
  }

  destroyAll(): void {
    for (const client of this.#clients) {
      client.destroy();
    }

    this.#clients.clear();
  }
}

function encodeTextFrame(payload: string): Buffer {
  const text = Buffer.from(payload);
  const length = text.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), text]);
  }

  if (length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, text]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, text]);
}
