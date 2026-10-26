import json
from pathlib import Path

import appconfig


def test_from_source_the_paths_are_the_repo_ones(tmp_path):
    paths = appconfig.resolve_paths({}, tmp_path / "repo", tmp_path / "home")
    assert paths["documentsRoot"] == (tmp_path / "repo" / "documents").resolve()
    assert paths["frontendDist"] == (tmp_path / "repo" / "frontend" / "3d-tool" / "dist" / "3d-tool" / "browser").resolve()
    assert paths["libraryRoot"] == (tmp_path / "home" / "Documents" / "3D" / "RASTERFASTER").resolve()


def test_environment_wins_everywhere(tmp_path):
    env = {"RF_ROOT": str(tmp_path / "lib"), "RF_DOCS": str(tmp_path / "docs"), "RF_FRONTEND": str(tmp_path / "web")}
    for frozen in (False, True):
        paths = appconfig.resolve_paths(env, tmp_path / "repo", tmp_path / "home", frozen, tmp_path / "bundle")
        assert paths == {"libraryRoot": (tmp_path / "lib").resolve(), "documentsRoot": (tmp_path / "docs").resolve(), "frontendDist": (tmp_path / "web").resolve()}


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
