"""HTTP front for save_generated.py, run from the deepagents image (the Docker bundle's `bridge`
service): the server image has no Python, the deepagents image has save_generated.py's imports.

POST /save  {"contract": {...}, "work_rel": "<generation folder relative to the workspace root, or ''>"}
         → 200 the script's JSON summary (+ "warn"), or 500 {"error": "<last stderr lines>"}
POST /assemble  same body → 200 the contract assembled from the folder (nothing saved)
GET  /health → 200
Env: as save_generated.py (PGPT_ROOT, TENANT_ID, SUPABASE_URL, SERVICE_ROLE_KEY); WORKSPACE
(deepagents' workspace root as mounted here); BRIDGE_PORT.
"""
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "save_generated.py")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        if self.path not in ("/save", "/assemble"):
            return self._send(404, {"error": "not found"})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        rel = str(body.get("work_rel") or "").lstrip("/")
        root = os.environ.get("WORKSPACE", "")
        work = os.path.normpath(os.path.join(root, rel)) if rel else ""
        if work and not work.startswith(root + os.sep):
            return self._send(400, {"error": "work_rel outside the workspace"})
        env = {**os.environ, "WORK_DIR": work, **({"ASSEMBLE_ONLY": "1"} if self.path == "/assemble" else {})}
        p = subprocess.run([sys.executable, SCRIPT], input=json.dumps(body.get("contract") or {}),
                           capture_output=True, text=True, env=env, timeout=600)
        err = p.stderr.strip()
        if p.returncode != 0:
            return self._send(500, {"error": " | ".join([l for l in err.split("\n") if l][-3:])})
        try:
            out = json.loads(p.stdout.strip().split("\n")[-1])
        except (ValueError, IndexError):
            return self._send(500, {"error": (p.stdout + err)[-500:]})
        self._send(200, {**out, **({"warn": err} if err else {})})

    def log_message(self, fmt, *args):
        sys.stderr.write("[bridge] " + fmt % args + "\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("BRIDGE_PORT", "8790"))), Handler).serve_forever()
