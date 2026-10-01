// WebSocket client for the relay (relay/PROTOCOL.md, "The relay"). One RelayLink = one
// WebSocket that has joined a room. Reconnecting is the caller's job (api.ts).

export class OfflineError extends Error {
  constructor() {
    super('Your desktop is not connected to the relay.');
  }
}

/** What api.ts needs from a connection; tests supply an in-memory one. */
export interface Transport {
  send(frame: unknown): void;
  close(): void;
  onFrame: (frame: any) => void;
  onEnd: (why: string) => void;
}

export type Connect = () => Promise<Transport>;

export class RelayLink implements Transport {
  onFrame: (frame: any) => void = () => {};
  onEnd: (why: string) => void = () => {};
  private ended = false;

  private constructor(private readonly ws: WebSocket) {}

  /** Open the socket, send the join, and resolve once the relay says `joined`. */
  static open(url: string, room: string, timeoutMs = 10_000): Promise<RelayLink> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new Error('Bad relay address.'));
        return;
      }
      const link = new RelayLink(ws);
      let joined = false;
      const timer = setTimeout(() => fail(new Error('The relay did not answer.')), timeoutMs);
      const fail = (e: Error) => {
        if (joined) return;
        joined = true; // settle once
        clearTimeout(timer);
        link.ended = true;
        try {
          ws.close();
        } catch {}
        reject(e);
      };

      ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room }));
      ws.onerror = () => fail(new Error('Cannot reach the relay.'));
      ws.onclose = () => {
        if (!joined) fail(new Error('The relay closed the connection.'));
        else link.end('closed');
      };
      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return; // not JSON: ignore
        }
        if (!joined) {
          if (msg?.t === 'joined') {
            joined = true;
            clearTimeout(timer);
            resolve(link);
          } else if (msg?.t === 'offline') {
            fail(new OfflineError());
          }
          return;
        }
        link.receive(msg);
      };
    });
  }

  private receive(msg: any) {
    if (msg && typeof msg === 'object' && msg.t === 'closed') {
      // The desktop's end went away.
      this.end('desktop closed');
      this.close();
      return;
    }
    // Accept both a bare frame and the relay's {"ch":n,"d":frame} wrapper.
    if (msg && typeof msg === 'object' && !('t' in msg) && 'ch' in msg && 'd' in msg) msg = msg.d;
    this.onFrame(msg);
  }

  private end(why: string) {
    if (this.ended) return;
    this.ended = true;
    this.onEnd(why);
  }

  send(frame: unknown) {
    if (this.ended || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  close() {
    try {
      this.ws.close();
    } catch {}
    this.end('closed by phone');
  }
}
