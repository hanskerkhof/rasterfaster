import json
from pathlib import Path

import appconfig


def test_from_source_the_paths_are_the_repo_ones(tmp_path):
    paths = appconfig.resolve_paths({}, tmp_path / "repo", tmp_path / "home")
    assert paths["documentsRoot"] == (tmp_path / "repo" / "documents").resolve()
    assert paths["frontendDist"] == (tmp_path / "repo" / "frontend" / "3d-tool" / "dist" / "3d-tool" / "browser").resolve()
    assert paths["libraryRoot"] == (tmp_path / "home" / "Documents" / "3D" / "RASTERFASTER").resolve()


def test_environment_wins_everywhere(tmp_path):
    env = {"RF_ROOT": str(tmp_path / "lib"), "RF_DOCS": str(tmp_path / "docs"), "RF_FRONTEND": str(tmp_path / "web"), "RF_BACKUP": str(tmp_path / "bak")}
    for frozen in (False, True):
        paths = appconfig.resolve_paths(env, tmp_path / "repo", tmp_path / "home", frozen, tmp_path / "bundle")
        assert {k: paths[k] for k in ("libraryRoot", "documentsRoot", "frontendDist")} == {"libraryRoot": (tmp_path / "lib").resolve(), "documentsRoot": (tmp_path / "docs").resolve(), "frontendDist": (tmp_path / "web").resolve()}


def test_packaged_app_uses_the_bundle_and_application_support(tmp_path):
    home = tmp_path / "home"
    paths = appconfig.resolve_paths({}, tmp_path / "repo", home, True, tmp_path / "bundle")
    assert paths["frontendDist"] == (tmp_path / "bundle" / "frontend").resolve()
    assert paths["documentsRoot"] == (home / "Library" / "Application Support" / "Rasterfaster" / "documents").resolve()
    appconfig.save_library_root(home, tmp_path / "my stl")
    assert json.loads(appconfig.config_file(home).read_text())["libraryRoot"] == str(tmp_path / "my stl")
    assert appconfig.resolve_paths({}, tmp_path / "repo", home, True, tmp_path / "bundle")["libraryRoot"] == (tmp_path / "my stl").resolve()


def test_broken_config_is_ignored(tmp_path):
    appconfig.config_file(tmp_path).parent.mkdir(parents=True)
    appconfig.config_file(tmp_path).write_text("not json")
    assert appconfig.read_config(tmp_path) == {}


def test_seed_documents_copy_once_and_never_overwrite(tmp_path):
    seed, target = tmp_path / "seed", tmp_path / "docs"
    seed.mkdir()
    (seed / "a.json").write_text('{"name": "A"}')
    (seed / "notes.txt").write_text("x")
    assert appconfig.seed_documents(target, seed) == 1 and (target / "a.json").is_file() and not (target / "notes.txt").exists()
    (target / "a.json").write_text('{"name": "edited"}')
    assert appconfig.seed_documents(target, seed) == 0  # the folder exists now: left alone
    assert json.loads((target / "a.json").read_text())["name"] == "edited"
    assert appconfig.seed_documents(tmp_path / "other", None) == 0


def make_pwa(folder: Path, name: str, url: str):
    import plistlib

    contents = folder / f"{name}.app" / "Contents"
    contents.mkdir(parents=True)
    (contents / "Info.plist").write_bytes(plistlib.dumps({"CrAppModeShortcutURL": url}))


def test_pwa_app_is_found_by_the_address_it_was_installed_from(tmp_path):
    import app

    make_pwa(tmp_path, "Other", "https://example.com/")
    make_pwa(tmp_path, "Rasterfaster dev", "http://localhost:4200/")
    make_pwa(tmp_path, "Rasterfaster", "http://localhost:8100/")
    (tmp_path / "Broken.app" / "Contents").mkdir(parents=True)  # no Info.plist: skipped
    assert app.pwa_app(8100, tmp_path).name == "Rasterfaster.app"
    assert app.pwa_app(4200, tmp_path).name == "Rasterfaster dev.app"
    assert app.pwa_app(9999, tmp_path) is None
    assert app.pwa_app(8100, tmp_path / "missing") is None


def test_pwa_watch_closes_only_after_it_was_seen_open_and_stayed_gone():
    import app

    now = [0.0]
    watch = app.PwaWatch(closeAfter=6, startupGrace=60, clock=lambda: now[0])

    def at(t, isOpen):
        now[0] = t
        return watch.sample(isOpen)

    assert at(1, False) == "waiting"  # still starting
    assert at(5, True) == "open"
    assert at(6, False) == "waiting"  # gone, but not for long enough
    assert at(8, True) == "open"  # came back (window moved / reopened): the countdown restarts
    assert at(9, False) == "waiting"
    assert at(14, False) == "waiting"
    assert at(15.5, False) == "closed"


def test_pwa_watch_gives_up_when_it_never_opens():
    import app

    now = [0.0]
    watch = app.PwaWatch(startupGrace=60, clock=lambda: now[0])
    now[0] = 30
    assert watch.sample(False) == "waiting"
    now[0] = 61
    assert watch.sample(False) == "never"


def test_backup_folder_defaults_to_3d_backup_and_can_be_configured(tmp_path):
    home = tmp_path / "home"
    assert appconfig.resolve_paths({}, tmp_path / "repo", home)["backupRoot"] == (home / "Documents" / "3D_BACKUP").resolve()
    assert appconfig.resolve_paths({"RF_BACKUP": str(tmp_path / "elsewhere")}, tmp_path / "repo", home)["backupRoot"] == (tmp_path / "elsewhere").resolve()
    appconfig.config_file(home).parent.mkdir(parents=True)
    appconfig.config_file(home).write_text(json.dumps({"backupRoot": str(tmp_path / "from-config")}))
    assert appconfig.resolve_paths({}, tmp_path / "repo", home)["backupRoot"] == (tmp_path / "from-config").resolve()
    assert appconfig.resolve_paths({"RF_BACKUP": str(tmp_path / "env")}, tmp_path / "repo", home)["backupRoot"] == (tmp_path / "env").resolve()
