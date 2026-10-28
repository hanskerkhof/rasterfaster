#!/usr/bin/env python3
"""Starts the whole local development stack in one terminal: the API and the Angular frontend, with one prefixed, coloured log stream.

    backend/.venv1/bin/python scripts/dev_stack.py                 # API (:8100) and frontend (:4200), opens the frontend in the browser
    backend/.venv1/bin/python scripts/dev_stack.py --no-open       # do not open a browser tab
    backend/.venv1/bin/python scripts/dev_stack.py --only 1        # only the API (numbers or names)
    backend/.venv1/bin/python scripts/dev_stack.py --skip rf-fe    # everything except one
    backend/.venv1/bin/python scripts/dev_stack.py --kill          # first stop whatever already listens on those ports (started elsewhere), then start

Keys (the terminal is read key by key, no Enter needed):
    1-2   restart that process       a  restart the API            f  restart the frontend
    t N   stop / start process N     l N  mute / unmute its log lines (they still go to its log file)
    o N   open a process in the browser
    s     status                     ?  help                        q or Ctrl-C  stop everything and quit

A restart of the API does NOT kill it: it asks the running API to re-execute itself (POST /api/runtime/restart), so the same process picks up
changed Python code and the logs continue. Only when that endpoint does not answer (or the API is not ours) is it stopped and started again.
The frontend is restarted by stopping it and starting it again (without opening another browser tab).

A port that is already in use is never taken over: that process is marked "external" and left alone (also when you quit), unless you
start with --kill: then the process listening on it is stopped first (only when it looks like that service: its API script or `ng serve`).
Every process also writes its output to tmp/dev-stack-logs/<name>.log (tail -f them in another terminal if you like).
Standard library only; Ctrl-C stops every child (each runs in its own process group, so nothing is left behind).
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import json
import os
import re
import shutil
import signal
import socket
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = ROOT / "tmp" / "dev-stack-logs"
VENV_PYTHON = ROOT / "backend" / ".venv1" / "bin" / "python"
PYTHON = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
STOP_GRACE_S = 6.0
READY_TIMEOUT_S = 120.0
RESET, DIM, BOLD = "\033[0m", "\033[2m", "\033[1m"


@dataclass
class Proc:
    index: int
    name: str
    kind: str                     # "api" or "fe"
    cwd: Path
    cmd: list[str]
    port: int
    color: str
    first_args: list[str] = field(default_factory=list)   # only on the first start (npm start -- --open)
    match: tuple[str, ...] = ()   # a listener on the port is only killed (--kill) when its command line contains one of these
    state: str = "stopped"        # stopped | starting | ready | restarting | exited | external
    child: asyncio.subprocess.Process | None = None
    started_at: float = 0.0
    restarts: int = 0
    muted: bool = False
    wanted_stop: bool = False
    logfile: object = None

    @property
    def tag(self) -> str:
        return f"{self.color}{self.index} {self.name:<10}{RESET}"

    @property
    def url(self) -> str:
        return f"http://localhost:{self.port}"


def build_procs() -> list[Proc]:
    api = lambda i, name, script, port, color: Proc(i, name, "api", ROOT / "backend", [PYTHON, script], port, color, match=(script,))  # noqa: E731
    fe = lambda i, name, folder, port, color: Proc(i, name, "fe", ROOT / "frontend" / folder, ["npm", "start"], port, color, first_args=["--", "--open"],  # noqa: E731
                                                   match=("@angular/cli", "node_modules/.bin/ng", "ng serve"))
    return [
        api(1, "rf-api", "main.py", 8100, "\033[36m"),
        fe(2, "rf-fe", "3d-tool", 4200, "\033[96m"),
    ]


def port_open(port: int) -> bool:
    """Something listens on the port, on IPv4 or IPv6 (`ng serve` binds localhost, which can be ::1 only)."""
    try:
        with socket.create_connection(("localhost", port), timeout=0.3):
            return True
    except OSError:
        return False


def ensure_modern_node() -> str | None:
    """The frontends need Node >= 20.19 / 22.12. Put a suitable nvm Node first on PATH when the one on PATH is missing or too old."""
    def version_of(node: str | None) -> tuple[int, ...] | None:
        if not node:
            return None
        try:
            out = os.popen(f'"{node}" --version').read().strip().lstrip("v")
            return tuple(int(x) for x in out.split(".")[:3])
        except ValueError:
            return None

    def ok(v: tuple[int, ...] | None) -> bool:
        return v is not None and (v >= (22, 12, 0) or (20, 19, 0) <= v < (21, 0, 0))

    current = version_of(shutil.which("node"))
    if ok(current):
        return None
    candidates = sorted((ROOT.parent / ".nvm" / "versions" / "node").glob("v*"), reverse=True) + sorted((Path.home() / ".nvm" / "versions" / "node").glob("v*"), reverse=True)
    for folder in candidates:
        if ok(version_of(str(folder / "bin" / "node"))):
            os.environ["PATH"] = f"{folder / 'bin'}{os.pathsep}{os.environ['PATH']}"
            return f"using Node from {folder.name}"
    return "no suitable Node (needs >= 20.19 or >= 22.12) found: the frontends may refuse to start (nvm use 22)"


class Stack:
    def __init__(self, procs: list[Proc], open_browser: bool) -> None:
        self.procs = procs
        self.open_browser = open_browser
        self.shutting_down = False
        self.pending_key: str | None = None
        self.tasks: set[asyncio.Task] = set()

    # ── output ─────────────────────────────────────────────────────────────
    def say(self, text: str) -> None:
        sys.stdout.write(f"{BOLD}[dev]{RESET} {text}\n")
        sys.stdout.flush()

    def emit(self, proc: Proc, line: str) -> None:
        if proc.logfile:
            proc.logfile.write(line + "\n")
            proc.logfile.flush()
        if not proc.muted:
            sys.stdout.write(f"{proc.tag} {DIM}|{RESET} {line}\n")
            sys.stdout.flush()

    def spawn_task(self, coro) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    # ── process control ────────────────────────────────────────────────────
    async def start(self, proc: Proc, first: bool = False) -> None:
        if port_open(proc.port):
            proc.state = "external"
            self.say(f"{proc.name}: port {proc.port} is already in use, leaving that process alone (marked external)")
            return
        if not shutil.which(proc.cmd[0]) and not Path(proc.cmd[0]).exists():
            self.say(f"{proc.name}: {proc.cmd[0]} not found")
            proc.state = "exited"
            return
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if proc.logfile:
            proc.logfile.close()
        proc.logfile = open(LOG_DIR / f"{proc.name}.log", "a", encoding="utf-8", errors="replace")
        proc.logfile.write(f"\n===== start {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
        cmd = proc.cmd + (proc.first_args if (first and self.open_browser) else [])
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        proc.wanted_stop = False
        proc.child = await asyncio.create_subprocess_exec(
            *cmd, cwd=str(proc.cwd), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL, env=env, start_new_session=True, limit=1 << 20)
        proc.state, proc.started_at = "starting", time.monotonic()
        self.say(f"{proc.name}: started (pid {proc.child.pid}), waiting for {proc.url}")
        self.spawn_task(self.pump(proc, proc.child))
        self.spawn_task(self.watch_ready(proc, proc.child))

    async def pump(self, proc: Proc, child: asyncio.subprocess.Process) -> None:
        assert child.stdout is not None
        try:
            while True:
                raw = await child.stdout.readline()
                if not raw:
                    break
                for line in re.split(r"[\r\n]+", raw.decode(errors="replace")):
                    if line.strip():
                        self.emit(proc, line.rstrip())
        except (asyncio.LimitOverrunError, ValueError):
            self.emit(proc, "[dev] output line too long, stream dropped")
        code = await child.wait()
        if proc.child is child:
            if proc.wanted_stop or self.shutting_down:
                proc.state = "stopped"
            else:
                proc.state = "exited"
                self.say(f"{proc.name}: exited with code {code}; press {proc.index} to start it again")

    async def watch_ready(self, proc: Proc, child: asyncio.subprocess.Process) -> None:
        began = time.monotonic()
        while proc.child is child and child.returncode is None and time.monotonic() - began < READY_TIMEOUT_S:
            if port_open(proc.port):
                proc.state = "ready"
                self.say(f"{proc.name}: ready on {proc.url} ({time.monotonic() - began:.1f}s)")
                return
            await asyncio.sleep(0.5)

    async def stop(self, proc: Proc) -> None:
        child = proc.child
        if child is None or child.returncode is not None:
            proc.state = "stopped" if proc.state != "external" else "external"
            return
        proc.wanted_stop = True
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(child.wait(), STOP_GRACE_S)
        except asyncio.TimeoutError:
            self.say(f"{proc.name}: did not stop in {STOP_GRACE_S:.0f}s, killing it")
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await child.wait()
        proc.state = "stopped"

    @staticmethod
    def listeners(port: int) -> list[int]:
        out = os.popen(f"lsof -nP -iTCP:{port} -sTCP:LISTEN -t 2>/dev/null").read().split()
        return sorted({int(x) for x in out if x.isdigit()})

    async def kill_listener(self, proc: Proc) -> bool:
        """--kill: stop the process that already listens on this process's port, when its command line is that service. True when the port is free."""
        pids = self.listeners(proc.port)
        if not pids:
            return not port_open(proc.port)
        mine = {os.getpgid(0), os.getpgid(os.getppid())}        # never take down this runner or the shell it runs in
        for pid in pids:
            command = os.popen(f"ps -o command= -p {pid}").read().strip()
            if proc.match and not any(m in command for m in proc.match):
                self.say(f"{proc.name}: port {proc.port} is used by pid {pid} ({command[:80]}), which is not this service: not killing it")
                return False
            try:
                group = os.getpgid(pid)
            except ProcessLookupError:
                continue
            self.say(f"{proc.name}: --kill: stopping pid {pid} ({command[:70]})")
            for sig, wait_s in ((signal.SIGTERM, STOP_GRACE_S), (signal.SIGKILL, 3.0)):
                try:
                    if group not in mine and group != pid and sig == signal.SIGTERM:
                        os.killpg(group, sig)               # a started `npm start` / its children go together
                    else:
                        os.kill(pid, sig)
                except ProcessLookupError:
                    break
                if await self.wait_port(proc.port, False, wait_s):
                    break
                self.say(f"{proc.name}: still listening after {wait_s:.0f}s" + (", killing it" if sig == signal.SIGTERM else ""))
        return await self.wait_port(proc.port, False, 3.0)

    async def api_reexec(self, proc: Proc) -> bool:
        """Ask a running API to re-execute itself; True when it accepted."""
        def post() -> bool:
            request = urllib.request.Request(f"http://127.0.0.1:{proc.port}/api/runtime/restart", data=json.dumps({"reason": "dev_stack_restart"}).encode(),
                                             headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=3) as response:
                    return 200 <= response.status < 300
            except (urllib.error.URLError, OSError):
                return False
        return await asyncio.get_running_loop().run_in_executor(None, post)

    async def wait_port(self, port: int, want_open: bool, timeout_s: float) -> bool:
        end = time.monotonic() + timeout_s
        while time.monotonic() < end:
            if port_open(port) == want_open:
                return True
            await asyncio.sleep(0.3)
        return False

    async def restart(self, proc: Proc) -> None:
        proc.restarts += 1
        if proc.kind == "api" and (proc.state in ("ready", "external", "restarting") or (proc.child and proc.child.returncode is None)):
            self.say(f"{proc.name}: asking it to re-execute (keeps the process and the logs)")
            if await self.api_reexec(proc):
                proc.state = "restarting"
                await self.wait_port(proc.port, False, 10)
                if await self.wait_port(proc.port, True, 90):
                    proc.state = "ready" if proc.child else "external"
                    self.say(f"{proc.name}: back on {proc.url}")
                else:
                    self.say(f"{proc.name}: did not come back within 90s, see its log")
                return
            if proc.state == "external" and not (proc.child and proc.child.returncode is None):
                self.say(f"{proc.name}: external process and its restart endpoint refused (auth on?). Not touching it")
                return
            self.say(f"{proc.name}: restart endpoint did not answer, stopping and starting it instead")
        if proc.child and proc.child.returncode is None:
            await self.stop(proc)
        await self.start(proc)

    async def toggle(self, proc: Proc) -> None:
        if proc.child and proc.child.returncode is None:
            await self.stop(proc)
            self.say(f"{proc.name}: stopped (t {proc.index} starts it again)")
        else:
            await self.start(proc)

    async def shutdown(self) -> None:
        if self.shutting_down:
            return
        self.shutting_down = True
        self.say("stopping everything ...")
        await asyncio.gather(*(self.stop(p) for p in self.procs if p.child), return_exceptions=True)
        for p in self.procs:
            if p.logfile:
                p.logfile.close()
        self.say("all stopped, bye")

    # ── keyboard ───────────────────────────────────────────────────────────
    def by_number(self, key: str) -> Proc | None:
        return next((p for p in self.procs if str(p.index) == key), None)

    def status(self) -> None:
        self.say("status")
        for p in self.procs:
            up = f"{time.monotonic() - p.started_at:.0f}s" if p.child and p.child.returncode is None and p.started_at else "-"
            pid = p.child.pid if p.child and p.child.returncode is None else "-"
            listening = "listening" if port_open(p.port) else "not listening"
            mute = "  [log muted]" if p.muted else ""
            print(f"  {p.tag} {p.state:<10} pid {str(pid):<6} up {up:<6} restarts {p.restarts}  :{p.port} {listening}{mute}")

    def help(self) -> None:
        print(__doc__.split("Keys", 1)[1].split("A restart of an API", 1)[0].rstrip().join(["Keys", ""]))

    def on_key(self, key: str) -> None:
        if self.shutting_down:
            return
        if self.pending_key:
            action, self.pending_key = self.pending_key, None
            proc = self.by_number(key)
            if not proc:
                self.say(f"no process {key!r}")
                return
            if action == "t":
                self.spawn_task(self.toggle(proc))
            elif action == "l":
                proc.muted = not proc.muted
                self.say(f"{proc.name}: log lines {'muted (still written to its log file)' if proc.muted else 'shown again'}")
            elif action == "o":
                os.system(f'open "{proc.url}"')
            return
        if key in "tlo":
            self.pending_key = key
            self.say(f"{key} ... which process (1-{len(self.procs)})?")
        elif key.isdigit() and (proc := self.by_number(key)):
            self.spawn_task(self.restart(proc))
        elif key == "a":
            self.spawn_task(self.restart_group("api"))
        elif key == "f":
            self.spawn_task(self.restart_group("fe"))
        elif key == "s":
            self.status()
        elif key in "?h":
            self.help()
        elif key in "q\x03\x04":
            self.spawn_task(self.shutdown())

    async def restart_group(self, kind: str) -> None:
        for p in [p for p in self.procs if p.kind == kind and p.state != "stopped"]:
            await self.restart(p)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Start the local development stack (API + frontend)")
    parser.add_argument("--no-open", action="store_true", help="do not open browser tabs when the frontends start")
    parser.add_argument("--only", default="", help="comma separated numbers or names to start, e.g. 1 or rf-api")
    parser.add_argument("--skip", default="", help="comma separated numbers or names not to start")
    parser.add_argument("--kill", action="store_true", help="first stop the processes that already listen on the ports of the chosen processes, then start them")
    args = parser.parse_args()
    procs = build_procs()

    def picked(spec: str) -> set[str]:
        return {s.strip().lower() for s in spec.split(",") if s.strip()}

    only, skip = picked(args.only), picked(args.skip)
    chosen = [p for p in procs if (not only or str(p.index) in only or p.name in only) and str(p.index) not in skip and p.name not in skip]
    if not chosen:
        print("nothing to start")
        return 1

    stack = Stack(procs, open_browser=not args.no_open)
    node_note = ensure_modern_node() if any(p.kind == "fe" for p in chosen) else None
    if node_note:
        stack.say(node_note)

    loop = asyncio.get_running_loop()
    done = asyncio.Event()

    def request_quit() -> None:
        if stack.shutting_down:                       # a second Ctrl-C: do not wait any longer
            for p in procs:
                if p.child and p.child.returncode is None:
                    try:
                        os.killpg(p.child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            done.set()
            return
        stack.spawn_task(shutdown_then_done())

    async def shutdown_then_done() -> None:
        await stack.shutdown()
        done.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, request_quit)

    fd = sys.stdin.fileno() if sys.stdin.isatty() else None
    if fd is not None:
        import termios
        import tty
        saved = termios.tcgetattr(fd)
        atexit.register(lambda: termios.tcsetattr(fd, termios.TCSADRAIN, saved))
        tty.setcbreak(fd)                              # keys without Enter; ISIG stays on, so Ctrl-C is still a signal

        def read_key() -> None:
            data = os.read(fd, 16).decode(errors="ignore")
            for ch in data:
                if ch == "q":
                    stack.on_key("q")
                    asyncio.ensure_future(wait_done())
                else:
                    stack.on_key(ch)

        async def wait_done() -> None:
            while not stack.shutting_down:
                await asyncio.sleep(0.05)
            while any(p.child and p.child.returncode is None for p in procs):
                await asyncio.sleep(0.1)
            done.set()

        loop.add_reader(fd, read_key)
    else:
        stack.say("stdin is not a terminal: keyboard commands are off (Ctrl-C still stops everything)")

    stack.say(f"starting {', '.join(p.name for p in chosen)}   (? = help, q or Ctrl-C = stop everything)")
    if args.kill:
        for p in chosen:
            if port_open(p.port) and not await stack.kill_listener(p):
                stack.say(f"{p.name}: port {p.port} could not be freed, leaving it (marked external)")
    for p in chosen:
        await stack.start(p, first=True)
    if not any(p.child for p in chosen):
        stack.say("nothing was started: every port is already in use. Those processes run somewhere else (their own terminal?), so this runner "
                  "cannot show their logs or stop them. Stop them first (Ctrl-C in their terminals) and start again, use --kill to stop them for you, or --only / --skip for the rest.")
        stack.shutting_down = True
        return 1
    await done.wait()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
