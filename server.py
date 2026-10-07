"""Python 3 fallback for the local, static heart-rate dashboard."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent


class DashboardHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404, 'Not found')
        return None

    def send_head(self):
        try:
            pathname = unquote(urlsplit(self.path).path, errors='strict')
            if ('\\' in pathname or '\0' in pathname
                    or any(part.startswith('.') for part in pathname.split('/'))):
                self.send_error(403, 'Forbidden')
                return None
            filename = (ROOT / pathname.lstrip('/')).resolve()
            filename.relative_to(ROOT)
        except (ValueError, OSError, UnicodeError):
            self.send_error(400, 'Invalid path')
            return None
        if pathname == '/':
            self.path = '/index.html'
        elif filename.suffix.lower() not in {'.html', '.js', '.mjs', '.css', '.jpg', '.jpeg', '.png', '.svg', '.ico', '.webp', '.json'}:
            self.send_error(404, 'Not found')
            return None
        return super().send_head()


def main():
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 8000), DashboardHandler)
    except OSError as error:
        raise SystemExit(f'Unable to open localhost:8000: {error}. Stop any other server using port 8000, then retry.')
    print('Open http://localhost:8000 — keep this window open; Ctrl+C stops the server.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
