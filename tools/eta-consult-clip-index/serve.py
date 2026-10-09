#!/usr/bin/python3
"""Tiny private file server for the consult-audio index (standard library only).

Refuses any path segment ending in .tmp (in-progress cutter folders).
Serves exactly two things from the www root: /index.html (also /) and /clips/<...>.flac with HTTP Range support.
No directory listings, no other file types, no traversal, GET/HEAD only. Logs path + status code only.
Binds ONLY the private address in env CONSULT_INDEX_BIND (required; no default), port 8099; --test allows another bind address (never 0.0.0.0) for local tests.
"""
import argparse, os, re, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TAILSCALE_IP = os.environ.get("CONSULT_INDEX_BIND")  # None = not configured   # private bind address, set per host (name kept from the original)
PORT = 8099
DEF_ROOT = os.path.join(os.path.expanduser("~"), "eta-data", "consult", "clip-index", "www")
CHUNK = 64 * 1024
MAXDIGITS = 15
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
SEC_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cache-Control", "no-store"),
    ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src 'self'; base-uri 'none'; form-action 'none'"),
)


def parse_range(header, size):
    """-> (start, end) inclusive, None for no/ignored Range header, or 'bad' for an unsatisfiable one."""
    if not header:
        return None
    m = RANGE_RE.match(header.strip())
    if not m:
        return None  # multi-range or malformed: ignore and serve the whole file (RFC 7233 allows it)
    a, b = m.groups()
    if a == "" and b == "":
        return None
    # digit strings longer than MAXDIGITS exceed any real file size: never int() them (huge ones raise ValueError)
    if a == "":  # suffix: last N bytes
        if len(b) > MAXDIGITS:
            return (0, size - 1) if size else "bad"
        n = int(b)
        if n == 0:
            return "bad"
        return (max(0, size - n), size - 1) if size else "bad"
    if len(a) > MAXDIGITS:
        return "bad"
    start = int(a)
    end = size - 1 if (b == "" or len(b) > MAXDIGITS) else int(b)
    if start >= size or end < start:
        return "bad"
    return (start, min(end, size - 1))


def resolve(root, url_path):
    """-> (kind, abs_path) with kind 'index' or 'flac', or None. Never returns a path outside root/clips (real path) or non-.flac."""
    if "\x00" in url_path or "\\" in url_path:
        return None
    p = urllib.parse.unquote(url_path)  # decode exactly once
    if "\x00" in p or "\\" in p:
        return None
    if p in ("/", "/index.html"):
        f = os.path.join(root, "index.html")
        return ("index", f) if os.path.isfile(f) else None
    if not p.startswith("/clips/") or not p.endswith(".flac"):
        return None
    parts = p[len("/clips/"):].split("/")
    if any(x in ("", ".", "..") or x.endswith(".tmp") for x in parts):  # .tmp = the cutter's in-progress folders
        return None
    clips_real = os.path.realpath(os.path.join(root, "clips"))
    f = os.path.realpath(os.path.join(clips_real, *parts))
    if not f.startswith(clips_real + os.sep) or not f.endswith(".flac") or not os.path.isfile(f):
        return None
    return ("flac", f)


class Handler(BaseHTTPRequestHandler):
    server_version = "consult-index"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 60
    root = DEF_ROOT

    # log path + status only (no client address, no query string, no headers)
    def log_request(self, code="-", size="-"):
        path = self._path_only()
        sys.stderr.write("%s %s %s\n" % (self.command, path, code))

    def _path_only(self):
        # raw request-target minus query/fragment; urlsplit() would read a leading // as a host, so it is not used here
        # self.path is unset when the stdlib rejects a request before parsing it (400/414)
        return getattr(self, "path", "").split("?", 1)[0].split("#", 1)[0]

    def log_message(self, fmt, *args):
        pass

    def log_error(self, fmt, *args):
        pass

    def _common(self):
        for k, v in SEC_HEADERS:
            self.send_header(k, v)

    def _plain(self, code, msg=b""):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(msg)))
        self._common()
        self.end_headers()
        if self.command != "HEAD" and msg:
            self.wfile.write(msg)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        r = resolve(self.root, self._path_only())
        if r is None:
            return self._plain(404, b"not found\n")
        kind, path = r
        try:
            size = os.path.getsize(path)
            fh = open(path, "rb")
        except OSError:
            return self._plain(404, b"not found\n")
        with fh:
            if kind == "index":
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(size))
                self._common()
                self.end_headers()
                if self.command != "HEAD":
                    self._copy(fh, size)
                return
            rng = parse_range(self.headers.get("Range"), size)
            if rng == "bad":
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self._common()
                self.end_headers()
                return
            if rng is None:
                start, end, code = 0, size - 1, 200
            else:
                (start, end), code = rng, 206
            length = end - start + 1 if size else 0
            self.send_response(code)
            self.send_header("Content-Type", "audio/flac")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if code == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self._common()
            self.end_headers()
            if self.command != "HEAD" and length:
                fh.seek(start)
                self._copy(fh, length)

    def _copy(self, fh, n):
        try:
            while n > 0:
                b = fh.read(min(CHUNK, n))
                if not b:
                    break
                self.wfile.write(b)
                n -= len(b)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True  # client seeked / left

    def _method_not_allowed(self):
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.close_connection = True  # never parse an unread request body as a second request
        self._common()
        self.end_headers()

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _method_not_allowed


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(bind, port, root):
    if bind in ("0.0.0.0", "", "::"):
        raise SystemExit("refusing to bind a wildcard address")
    h = type("H", (Handler,), {"root": root})
    return Server((bind, port), h)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=DEF_ROOT)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--bind", default=TAILSCALE_IP)
    ap.add_argument("--test", action="store_true", help="allow a bind address other than the Tailscale IP (local testing only)")
    a = ap.parse_args(argv)
    if a.bind is None:
        raise SystemExit("set CONSULT_INDEX_BIND (or pass --bind with --test)")
    if a.bind != TAILSCALE_IP and not a.test:
        raise SystemExit("--bind other than %s needs --test" % TAILSCALE_IP)
    srv = make_server(a.bind, a.port, os.path.abspath(a.root))
    sys.stderr.write("listening %s:%d root=%s\n" % (a.bind, a.port, a.root))
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
