#!/usr/bin/env python3


import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CRC_JS = HERE.parent / "bin" / "crc.js"
SCHEMA = HERE.parent / "schema" / "crc.schema.json"
INDEX = HERE / "index.html"

STATE = {"path": None, "mtime": None}
LOCK = threading.Lock()


# -- file stuff

def find_config(start):
    d = Path(start).resolve()
    for p in [d, *d.parents]:
        f = p / "crc.config.json"
        if f.is_file():
            return f
    return None


def default_cards_path():
    cfg = find_config(Path.cwd())
    if cfg:
        try:
            cards = json.loads(cfg.read_text(encoding="utf-8")).get("cards")
        except (OSError, ValueError):
            cards = None
        if cards and cards.lower().endswith(".json"):
            return (cfg.parent / cards).resolve()
    return (Path.cwd() / "cards.json").resolve()


def read_project():
    """The whole file as a dict with at least cards and subsystems."""
    path = STATE["path"]
    if not path.exists():
        STATE["mtime"] = None
        return {"cards": [], "subsystems": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):  # a bare array of cards is valid crc input i guess 
        data = {"cards": data}
    data.setdefault("cards", [])
    data.setdefault("subsystems", [])
    STATE["mtime"] = path.stat().st_mtime
    return data


def write_project(cards, subsystems):
    """Replace cards and subsystem cards, keeping anything else in the file (walkthroughs, $schema)."""
    path = STATE["path"]
    data = {}
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        data = old if isinstance(old, dict) else {}
    # $schema first gives VS Code autocomplete when the file is opened by hand.
    data = {"$schema": data.get("$schema", SCHEMA.as_uri()), **{k: v for k, v in data.items() if k != "$schema"}}
    data["cards"] = cards
    if subsystems:
        data["subsystems"] = subsystems
    else:
        data.pop("subsystems", None)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    STATE["mtime"] = path.stat().st_mtime


# toolkit

def run_crc(args):
    """Run bin/crc.js with the cards file; config comes from the file's folder."""
    node = shutil.which("node")
    if not node:
        return None, "Node isn't on your PATH, so checking and graphs are off. Install Node 20+."
    if not STATE["path"].exists():
        return None, "Save a card first."
    # The path goes right after the command: crc's parser lets a flag take the next bare word as its value.
    cmd = [node, str(CRC_JS), args[0], str(STATE["path"]), *args[1:], "--config-dir", str(STATE["path"].parent)]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=67) #6 7 6 7 6 7 6 7 6 7 6 7 6 7 6 7 6 7 6 7 6 7 67 6 6 667 67 67 67 67 6 6 7 76 7 67 6 7 67 6 7 67
    return p, None


def check():
    p, err = run_crc(["check", "--json"])
    if err:
        return {"error": err}
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {"error": (p.stderr or p.stdout).strip() or "crc check failed :( "}


def graph(subsystem):
    args = ["graph", "--format", "svg"]
    if subsystem:
        args += ["--subsystem", subsystem, "--title", f"{subsystem} — Collaboration Graph"]
    else:
        args += ["--title", "Collaboration Graph"]
    p, err = run_crc(args)
    if err:
        return {"error": err}
    if p.returncode != 0 or "<svg" not in p.stdout:
        return {"error": (p.stderr or p.stdout).strip() or "crc graph failed"}
    return {"svg": p.stdout}


# ----- http

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        url = self.path.split("?")[0]
        if url in ("/", "/index.html"):
            body = INDEX.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url == "/api/project":
            with LOCK:
                try:
                    data = read_project()
                except (OSError, ValueError) as e:
                    return self.send_json({"error": f"Couldn't read {STATE['path']}: {e}"}, 500)
            self.send_json({"path": str(STATE["path"]), "exists": STATE["path"].exists(), "mtime": STATE["mtime"],
                            "cards": data["cards"], "subsystems": data["subsystems"]})
        else:
            self.send_error(404)

    def do_POST(self):
        url = self.path.split("?")[0]
        try:
            body = self.read_json()
        except ValueError:
            return self.send_json({"error": "bad JSON"}, 400)
        if url == "/api/save":
            with LOCK:
                path = STATE["path"]
                disk = path.stat().st_mtime if path.exists() else None
                # Someone else (an editor, the agent pipeline) changed the file since we loaded it.
                if not body.get("force") and disk != body.get("mtime"):
                    return self.send_json({"conflict": True, "error": f"{path.name} changed on disk since it was loaded."}, 409)
                try:
                    write_project(body.get("cards", []), body.get("subsystems", []))
                except OSError as e:
                    return self.send_json({"error": str(e)}, 500)
            self.send_json({"ok": True, "mtime": STATE["mtime"]})
        elif url == "/api/check":
            self.send_json(check())
        elif url == "/api/graph":
            self.send_json(graph(body.get("subsystem")))
        else:
            self.send_error(404)


def main():
    ap = argparse.ArgumentParser(description="Local UI for making and viewing CRC cards.")
    ap.add_argument("cards", nargs="?", help="cards JSON file (created on first save)")
    ap.add_argument("--port", type=int, default=8615)
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    a = ap.parse_args()

    path = Path(a.cards).expanduser().resolve() if a.cards else default_cards_path()
    if path.suffix.lower() == ".md":
        sys.exit(f"The UI edits JSON cards. Convert first:\n  node {CRC_JS} convert {path} {path.with_suffix('.json')}")
    STATE["path"] = path
    if path.exists():
        try:
            read_project()
        except ValueError as e:
            sys.exit(f"{path} isn't valid JSON: {e}")

    try:
        server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # port taken: pick a free one
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"CRC cards UI at {url}\nediting {path}{'' if path.exists() else ' (new file)'}\nCtrl+C to stop.", flush=True)
    if not a.no_open:
        threading.Timer(0.3, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
