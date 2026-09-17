import { createServer, type Socket } from 'node:net';
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// A local SMTP recipient: no external recipients, and no mocked send/sendMail.
export async function smtpRecipient(acknowledge?: Promise<void>) {
  const sockets = new Set<Socket>();
  const messages: string[] = [];
  const received = deferred<void>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 localhost ESMTP\r\n');
    let input = '';
    let data = false;
    let body = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n');
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (data) {
          if (line !== '.') { body += line + '\n'; continue; }
          messages.push(body);
          received.resolve();
          body = '';
          data = false;
          if (acknowledge) void acknowledge.then(() => socket.write('250 accepted\r\n'));
          else socket.write('250 accepted\r\n');
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/.test(line)) socket.write('235 authenticated\r\n');
        else if (/^DATA/.test(line)) { data = true; socket.write('354 send message\r\n'); }
        else if (/^QUIT/.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    messages, received,
    channel: { id: 1, name: 'local SMTP', enabled: true, type: 'email' as const,
      created_at: new Date(), updated_at: new Date(),
      config: { smtp_host: '127.0.0.1', smtp_port: address.port, smtp_secure: false, smtp_require_tls: false,
        smtp_username: 'test', password: 'test', from: 'sender@example.test', to: 'recipient@example.test' } },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
