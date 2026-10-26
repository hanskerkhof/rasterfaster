"""Rasterfaster Server: starts the API (which also serves the web app), opens the installed Rasterfaster PWA and stops the API when
the PWA is closed.

    python app.py     start the API and open the PWA installed from http://localhost:<port>/ (no Dock icon of its own: the PWA is the app);
                      when the PWA window is closed (or the PWA quits) the API stops and this process ends.
                      Without an installed PWA it opens the address in Chrome and keeps a Dock icon (Quit stops the API).

Packaged (scripts/build-app.sh): click "Rasterfaster Server.app". `python main.py` + `npm start` stay the way to develop.
Environment: RF_NO_OPEN=1 starts without opening or watching anything (tests).
"""
import os
import plistlib
import socket
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

import uvicorn

import main

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


def pwa_app(port: int, appsDir: Path | None = None) -> Path | None:
    """The Chrome PWA (an .app in ~/Applications/Chrome Apps.localized) that was installed from this server's address, if there is one."""
    folder = appsDir or Path.home() / "Applications" / "Chrome Apps.localized"
    wanted = {f"http://localhost:{port}/", f"http://127.0.0.1:{port}/"}
    for bundle in sorted(folder.glob("*.app")):
        try:
            info = plistlib.loads((bundle / "Contents" / "Info.plist").read_bytes())
        except (OSError, ValueError):
            continue
        if str(info.get("CrAppModeShortcutURL", "")) in wanted:
            return bundle
    return None


def open_pwa(port: int) -> None:
    """Opens the installed PWA; without one, opens the address in Chrome (where it can be installed) or the default browser."""
    if os.environ.get("RF_NO_OPEN"):
        return
    url = f"http://localhost:{port}/"
    bundle = pwa_app(port)
    if bundle:
        subprocess.run(["open", str(bundle)], check=False)
    elif Path("/Applications/Google Chrome.app").exists():
        subprocess.run(["open", "-a", "Google Chrome", url], check=False)
    else:
        subprocess.run(["open", url], check=False)


def start_api() -> tuple[int, uvicorn.Server | None]:
    """Starts the API, unless one already answers on the preferred port (then that one is used and left alone)."""
    port = preferredPort
    if answers(port):
        return port, None
    if not port_is_free(port):
        port = free_port()
    return port, start_server(port)


class PwaWatch:
    """Decides from once-a-second samples ("is the PWA open?") when it has been closed: it must have been seen open first, then be gone for
    `closeAfter` seconds (a window being reopened or moved between spaces does not count). Never seen open within `startupGrace` seconds: "never"."""

    def __init__(self, closeAfter: float = 6.0, startupGrace: float = 60.0, clock=time.monotonic):
        self.closeAfter, self.startupGrace, self.clock = closeAfter, startupGrace, clock
        self.started = clock()
        self.seen = False
        self.goneSince: float | None = None

    def sample(self, isOpen: bool) -> str:
        """"open", "closed" (it was open and is gone), "never" (it did not open at all) or "waiting"."""
        now = self.clock()
        if isOpen:
            self.seen, self.goneSince = True, None
            return "open"
        if not self.seen:
            return "never" if now - self.started > self.startupGrace else "waiting"
        self.goneSince = self.goneSince if self.goneSince is not None else now
        return "closed" if now - self.goneSince >= self.closeAfter else "waiting"


def pwa_bundle_id(bundle: Path) -> str | None:
    try:
        return plistlib.loads((bundle / "Contents" / "Info.plist").read_bytes()).get("CFBundleIdentifier")
    except (OSError, ValueError):
        return None


def pwa_open(bundleId: str) -> bool:
    """True while the PWA is running and has a real window (closing the window may leave the app running in the Dock)."""
    import Quartz
    from AppKit import NSWorkspace

    pids = {app.processIdentifier() for app in NSWorkspace.sharedWorkspace().runningApplications() if app.bundleIdentifier() == bundleId}
    if not pids:
        return False
    for window in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID):
        bounds = window.get("kCGWindowBounds", {})
        if window.get("kCGWindowOwnerPID") in pids and window.get("kCGWindowLayer") == 0 and bounds.get("Width", 0) > 200 and bounds.get("Height", 0) > 200:
            return True
    return False


def quit_pwa(bundleId: str) -> None:
    from AppKit import NSWorkspace

    for app in NSWorkspace.sharedWorkspace().runningApplications():
        if app.bundleIdentifier() == bundleId:
            app.terminate()


def run_serve() -> None:
    """Starts the API, opens the PWA and ends everything when the PWA is closed. Without an installed PWA there is a Dock icon with Quit."""
    from AppKit import NSApplication, NSApplicationActivationPolicyAccessory, NSApplicationActivationPolicyRegular, NSMenu, NSMenuItem, NSObject
    from PyObjCTools import AppHelper

    port, server = start_api()
    bundle = None if os.environ.get("RF_NO_OPEN") else pwa_app(port)
    bundleId = pwa_bundle_id(bundle) if bundle else None

    class Delegate(NSObject):
        def applicationShouldHandleReopen_hasVisibleWindows_(self, application, hasWindows):
            open_pwa(port)
            return True

        def openPwa_(self, sender):
            open_pwa(port)

        def applicationWillTerminate_(self, notification):
            if server:
                server.should_exit = True

    application = NSApplication.sharedApplication()
    delegate = Delegate.alloc().init()
    application.setDelegate_(delegate)
    menubar, appItem, appMenu = NSMenu.alloc().init(), NSMenuItem.alloc().init(), NSMenu.alloc().init()
    menubar.addItem_(appItem)
    openItem = appMenu.addItemWithTitle_action_keyEquivalent_("Open Rasterfaster", "openPwa:", "o")
    openItem.setTarget_(delegate)
    appMenu.addItemWithTitle_action_keyEquivalent_("Quit Rasterfaster Server", "terminate:", "q")
    appItem.setSubmenu_(appMenu)
    application.setMainMenu_(menubar)
    # With a PWA the PWA is the app: no Dock icon here. Without one (or when it never shows up) keep a Dock icon so it can be quit.
    application.setActivationPolicy_(NSApplicationActivationPolicyAccessory if bundleId else NSApplicationActivationPolicyRegular)

    def watch() -> None:
        pwa = PwaWatch()
        while True:
            time.sleep(1)
            state = pwa.sample(pwa_open(bundleId))
            if state == "closed":
                quit_pwa(bundleId)  # the window is gone but the app may linger in the Dock
                AppHelper.callAfter(application.terminate_, None)
                return
            if state == "never":
                AppHelper.callAfter(application.setActivationPolicy_, NSApplicationActivationPolicyRegular)
                return

    open_pwa(port)
    if bundleId:
        threading.Thread(target=watch, name="rasterfaster-pwa-watch", daemon=True).start()
    application.run()


if __name__ == "__main__":
    run_serve()
