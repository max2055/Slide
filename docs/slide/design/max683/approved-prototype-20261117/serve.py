"""Optional local server for clean legacy paths. File opening needs no server."""
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
import argparse

class ReviewHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path in ('/investigations','/operations-actions'):
            self.path='/index.html'
        super().do_GET()

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),partial(ReviewHandler,directory=str(Path(__file__).resolve().parent)))
    print('Slide design review: http://127.0.0.1:%d/'%server.server_port,flush=True)
    server.serve_forever()
