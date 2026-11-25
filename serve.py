"""Local development server for SoundStudio.

Like `python -m http.server`, but tells the browser not to cache files, so a
normal refresh always picks up your latest changes.

Usage:  python serve.py [port]      (default port 8000)
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler)
    print(f"SoundStudio running at http://localhost:{port}  (Ctrl+C to stop)")
    server.serve_forever()
