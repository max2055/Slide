"""Check the repository's two nginx hops with a disposable TLS/WebSocket fixture.

Run with Python 3 (without -O), Docker and OpenSSL; no product credentials or LLM.
Only loopback ports are published. This does not qualify a real Edge deployment.
"""

import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0'
NAME = 'slide-tls-transport-' + str(os.getpid())
containers = []


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def start(role, *args):
    name = NAME + '-' + role
    run('docker', 'run', '-d', '--name', name, '--label', 'slide.task=MAX-183',
        '--network', NAME, '--network-alias', role, *args)
    containers.append(name)
    return name


def read_exact(stream, length):
    data = b''
    while len(data) < length:
        part = stream.recv(length - len(data))
        if not part:
            raise RuntimeError('unexpected EOF')
        data += part
    return data


BACKEND = '''import base64, hashlib, socketserver, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class WS(socketserver.BaseRequestHandler):
 def handle(self):
  self.request.settimeout(5)
  stream=self.request.makefile('rb')
  request=stream.readline()
  headers={}
  while True:
   line=stream.readline()
   if not line: return
   if line==b'\\r\\n': break
   key,value=line.decode().split(':',1); headers[key.lower()]=value.strip()
  assert request.startswith(b'GET /agent-ws HTTP/1.1')
  assert headers['x-forwarded-proto']=='https'
  assert headers['upgrade'].lower()=='websocket'
  accept=base64.b64encode(hashlib.sha1((headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
  self.request.sendall(b'HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+b'\\r\\n\\r\\n')
  for _ in range(3):
   head=stream.read(2); assert head[0]==0x81 and head[1]&0x80
   size=head[1]&127; assert size<126
   mask=stream.read(4); data=stream.read(size)
   payload=bytes(value^mask[i%4] for i,value in enumerate(data))
   self.request.sendall(bytes([0x81,len(payload)])+payload)
class HTTP(BaseHTTPRequestHandler):
 def do_GET(self):
  assert self.headers['X-Forwarded-Proto']=='https'
  self.send_response(200); self.end_headers(); self.wfile.write(b'{"transportFixture":true}')
 def log_message(self,*args): pass
server=socketserver.ThreadingTCPServer(('0.0.0.0',28888),WS)
threading.Thread(target=server.serve_forever,daemon=True).start()
ThreadingHTTPServer(('0.0.0.0',3000),HTTP).serve_forever()
'''

if not __debug__:
    raise SystemExit('Run without -O: this qualification requires assertions')

with tempfile.TemporaryDirectory(prefix='slide-tls-transport-') as tmp:
    directory = Path(tmp)
    (directory / 'backend.py').write_text(BACKEND)
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=MAX-183 local transport fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', str(directory / 'tls.key'), '-out', str(directory / 'tls.crt'))
    # Disposable fixture only: nginx's unprivileged UID must read this test key.
    (directory / 'tls.key').chmod(0o644)
    run('docker', 'network', 'create', '--label', 'slide.task=MAX-183', NAME)
    try:
        start('api', '-v', f'{directory}/backend.py:/backend.py:ro',
              'python:3.13-alpine@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0', 'python', '/backend.py')
        frontend = start('frontend', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                         '--tmpfs', '/tmp', '-v', f'{ROOT}/frontend/nginx.conf:/etc/nginx/conf.d/default.conf:ro', IMAGE)
        edge = start('edge', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                     '--tmpfs', '/tmp', '-p', '127.0.0.1::8443', '-p', '127.0.0.1::8080',
                     '-v', f'{ROOT}/deploy/nginx-tls.conf:/etc/nginx/conf.d/default.conf:ro',
                     '-v', f'{directory}/tls.crt:/etc/nginx/tls/tls.crt:ro',
                     '-v', f'{directory}/tls.key:/etc/nginx/tls/tls.key:ro', IMAGE)
        https_port = int(run('docker', 'port', edge, '8443/tcp').rsplit(':', 1)[1])
        http_port = int(run('docker', 'port', edge, '8080/tcp').rsplit(':', 1)[1])
        trust = ssl.create_default_context(cafile=str(directory / 'tls.crt'))
        deadline = time.monotonic() + 20
        while True:
            try:
                conn = http.client.HTTPSConnection('127.0.0.1', https_port, context=trust, timeout=2)
                conn.request('GET', '/api/health')
                response = conn.getresponse()
                assert response.status == 200 and json.loads(response.read())['transportFixture']
                conn.close()
                break
            except (OSError, AssertionError, http.client.HTTPException):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.2)
        for name in [frontend, edge]:
            assert 'test is successful' in run('docker', 'exec', name, 'nginx', '-t')
        try:
            with socket.create_connection(('127.0.0.1', https_port), timeout=5) as raw:
                ssl.create_default_context().wrap_socket(raw, server_hostname='127.0.0.1')
        except ssl.SSLCertVerificationError:
            pass
        else:
            raise AssertionError('untrusted fixture certificate was accepted')
        conn = http.client.HTTPConnection('127.0.0.1', http_port, timeout=3)
        conn.request('GET', '/?tab=chat', headers={'Host': 'slide.example.com'})
        response = conn.getresponse()
        assert response.status == 308
        assert response.getheader('Location') == 'https://slide.example.com/?tab=chat'
        conn.close()
        for attempt in range(5):
            with socket.create_connection(('127.0.0.1', https_port), timeout=5) as raw:
                with trust.wrap_socket(raw, server_hostname='127.0.0.1') as stream:
                    key = base64.b64encode(os.urandom(16)).decode()
                    stream.sendall((f'GET /agent-ws HTTP/1.1\r\nHost: 127.0.0.1:{https_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
                    header = b''
                    while not header.endswith(b'\r\n\r\n'):
                        header += read_exact(stream, 1)
                    assert header.startswith(b'HTTP/1.1 101 ')
                    accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
                    headers = dict(line.split(b':', 1) for line in header.split(b'\r\n')[1:] if b':' in line)
                    assert next(value.strip() for name, value in headers.items()
                                if name.lower() == b'sec-websocket-accept') == accept
                    for frame in range(3):
                        payload = f'MAX-183-{attempt}-{frame}'.encode()
                        mask = os.urandom(4)
                        stream.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(payload)))
                        assert read_exact(stream, 2) == bytes([0x81, len(payload)])
                        assert read_exact(stream, len(payload)) == payload
        print(json.dumps({'nginxConfig': 'both hops passed', 'https': 'verified fixture trust and IP SAN',
                          'untrustedCertificate': 'rejected', 'redirect': 308,
                          'websocketUpgrades': 5, 'echoFrames': 15,
                          'forwardedProto': 'https at backend', 'backend': 'isolated Python echo fixture; no product or LLM',
                          'edgeImage': IMAGE}, ensure_ascii=False, indent=2))
    finally:
        for name in reversed(containers):
            run('docker', 'rm', '-f', name)
        run('docker', 'network', 'rm', NAME)
