import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import main


@pytest.fixture
def served(tmp_path):
    (tmp_path / "index.html").write_text("<app-root>shell</app-root>")
    (tmp_path / "ngsw.json").write_text("{}")
    (tmp_path / "main-ABC.js").write_text("console.log(1)")
    application = FastAPI()

    @application.get("/api/ping")
    def ping():
        return {"ok": True}

    assert main.mount_frontend(application, tmp_path)
    return TestClient(application)


def test_nothing_is_mounted_without_a_build(tmp_path):
    assert main.mount_frontend(FastAPI(), tmp_path) is False


def test_serves_the_app_files_and_the_shell_for_unknown_routes(served):
    assert "shell" in served.get("/").text
    assert served.get("/main-ABC.js").text == "console.log(1)"
    assert "shell" in served.get("/some/deep/route").text  # single-page fallback


def test_api_routes_and_missing_files_are_not_swallowed_by_the_fallback(served):
    assert served.get("/api/ping").json() == {"ok": True}
    assert served.get("/api/nope").status_code == 404
    assert "shell" not in served.get("/api/nope").text
    assert served.get("/missing-file.js").status_code == 404  # a file with an extension is never a route


def test_the_app_shell_and_service_worker_files_are_always_revalidated(served):
    for path in ("/", "/index.html", "/ngsw.json"):
        assert served.get(path).headers["cache-control"] == "no-cache"
    assert "cache-control" not in served.get("/main-ABC.js").headers  # hashed files may be cached
    assert "cache-control" not in served.get("/api/ping").headers
