"""Rasterfaster as a desktop app: starts the API in a background thread and shows the UI in a native window.

Run from source:  .venv-app/bin/python app.py      Packaged (see scripts/build-app.sh): double-click Rasterfaster.app.
`python main.py` + `npm start` stay the way to develop; this file only wraps main.app.
"""
import socket
import threading
import time
import urllib.request
from pathlib import Path

import uvicorn
import webview

import appconfig
import main

windowTitle = "Rasterfaster"
preferredPort = main.apiPort


def answers(port: int) -> bool:
    """True when a Rasterfaster API already answers on this port (a second launch then just opens another window on it)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def port_is_free(port: int) -> bool:
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) != 0


def start_server(port: int) -> uvicorn.Server:
    server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=port, log_level="warning", timeout_graceful_shutdown=2))
    threading.Thread(target=server.run, name="rasterfaster-api", daemon=True).start()
    deadline = time.time() + 20
    while not answers(port):
        if time.time() > deadline:
            raise RuntimeError("the API did not start")
        time.sleep(0.1)
    return server


def ask_for_library(window: webview.Window) -> None:
    """The STL library folder does not exist (first run on another machine): let the user pick it, remember it, and reload the UI."""
    if main.libraryRoot.is_dir():
        return
    picked = window.create_file_dialog(webview.FOLDER_DIALOG, directory=str(Path.home()))
    if picked:
        main.libraryRoot = Path(picked[0]).resolve()
        appconfig.save_library_root(Path.home(), main.libraryRoot)
        window.evaluate_js("location.reload()")


def run() -> None:
    server = None
    port = preferredPort
    if not answers(port):
        if not port_is_free(port):
            port = free_port()
        server = start_server(port)
    webview.settings["ALLOW_DOWNLOADS"] = True  # the export buttons download files
    window = webview.create_window(windowTitle, f"http://127.0.0.1:{port}/", width=1440, height=900, min_size=(900, 600))
    webview.start(ask_for_library, window)
    if server:
        server.should_exit = True


if __name__ == "__main__":
    run()
