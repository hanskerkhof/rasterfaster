"""Tests of the file naming and version logic of the add-in (Fusion's own modules are replaced by stand-ins)."""
import sys
import types
from pathlib import Path

for name in ("adsk", "adsk.core", "adsk.fusion"):
    module = types.ModuleType(name)
    sys.modules[name] = module
sys.modules["adsk"].core = sys.modules["adsk.core"]
sys.modules["adsk"].fusion = sys.modules["adsk.fusion"]
for handler in ("CommandCreatedEventHandler", "CommandEventHandler", "InputChangedEventHandler", "CustomEventHandler", "DocumentEventHandler", "ApplicationCommandEventHandler"):
    setattr(sys.modules["adsk.core"], handler, type(handler, (), {}))

sys.path.insert(0, str(Path(__file__).parent / "AddInRasterfasterLocalF3D"))
import AddInRasterfasterLocalF3D as addin


def test_base_name_drops_the_version_in_both_spellings():
    assert addin.base_name("RF14_v2") == "RF14"
    assert addin.base_name("RF14 v4") == "RF14"
    assert addin.base_name("RF14") == "RF14"
    assert addin.base_name("RF1 BASE v10") == "RF1 BASE"
    assert addin.base_name("my_v2_part") == "my_v2_part"  # only a trailing version counts
    assert addin.base_name("a/b:c") == "a-b-c"


def test_a_versioned_save_is_one_above_the_highest_on_disk(tmp_path):
    for name in ["RF14_v1.f3d", "RF14_v2.f3d", "RF14 v7.f3d", "RF14.f3d", "RF140_v9.f3d", "RF14_v3.f3d.bak", ".RF14_v99.saving.f3d", "OTHER_v50.f3d"]:
        (tmp_path / name).write_bytes(b"x")
    target, highest = addin.planned_target(str(tmp_path), "RF14_v2", True)
    assert Path(target).name == "RF14_v8.f3d" and highest == 7


def test_first_version_and_missing_folder(tmp_path):
    target, highest = addin.planned_target(str(tmp_path), "RF14", True)
    assert Path(target).name == "RF14_v1.f3d" and highest == 0
    target, highest = addin.planned_target(str(tmp_path / "nope"), "RF14", True)
    assert Path(target).name == "RF14_v1.f3d"


def test_without_versioning_the_name_is_used_as_it_is(tmp_path):
    target, highest = addin.planned_target(str(tmp_path), "RF14 v4", False)
    assert Path(target).name == "RF14.f3d" and highest is None
    target, _ = addin.planned_target(str(tmp_path), "RF14_v2", False)
    assert Path(target).name == "RF14_v2.f3d"


def test_the_preview_text(tmp_path):
    (tmp_path / "RF14_v3.f3d").write_bytes(b"x")
    assert "latest on disk: v3" in addin.describe(*addin.planned_target(str(tmp_path), "RF14", True))
    assert "no version on disk" in addin.describe(*addin.planned_target(str(tmp_path), "NEW", True))
    assert "replaces" in addin.describe(*addin.planned_target(str(tmp_path), "RF14_v3", False))


def test_the_add_in_version_is_the_one_in_the_manifest():
    import json
    manifest = json.loads((Path(__file__).parent / "AddInRasterfasterLocalF3D" / "AddInRasterfasterLocalF3D.manifest").read_text())
    assert addin.addin_version() == manifest["version"] != ""


def _touch(path, size=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def test_version_numbers_never_restart_after_older_versions_moved_to_versions(tmp_path):
    for name in ["RF14_v4.f3d", "RF14_v5.f3d"]:
        _touch(tmp_path / name)
    for name in ["RF14_v1.f3d", "RF14 v2.f3d", "RF14_v3.f3d"]:
        _touch(tmp_path / "VERSIONS" / name)
    target, highest = addin.planned_target(str(tmp_path), "RF14", True)
    assert Path(target).name == "RF14_v6.f3d" and highest == 5
    _touch(tmp_path / "VERSIONS" / "RF14_v9.f3d")
    assert addin.planned_target(str(tmp_path), "RF14", True)[1] == 9  # only the VERSIONS folder has v9


def test_older_versions_move_but_the_new_file_and_other_designs_stay(tmp_path):
    for name in ["RF14_v1.f3d", "RF14_v2.f3d", "RF14 v3.f3d", "RF14_v4.f3d", "RF14.f3d", "RF140_v1.f3d", "OTHER_v1.f3d", "notes.txt"]:
        _touch(tmp_path / name)
    moved = addin.archive_versions(str(tmp_path), "RF14", keep=str(tmp_path / "RF14_v4.f3d"))
    assert moved == 4                                                                      # three versions and the unversioned original
    assert sorted(p.name for p in (tmp_path / "VERSIONS").iterdir()) == ["RF14 v3.f3d", "RF14.f3d", "RF14_v1.f3d", "RF14_v2.f3d"]
    assert sorted(p.name for p in tmp_path.iterdir() if p.is_file()) == ["OTHER_v1.f3d", "RF140_v1.f3d", "RF14_v4.f3d", "notes.txt"]
    assert addin.archive_versions(str(tmp_path), "RF14", keep=str(tmp_path / "RF14_v4.f3d")) == 0


def test_a_file_in_versions_is_never_overwritten(tmp_path):
    _touch(tmp_path / "RF14_v1.f3d", 5)
    _touch(tmp_path / "VERSIONS" / "RF14_v1.f3d", 3)
    assert addin.archive_versions(str(tmp_path), "RF14") == 1
    sizes = sorted(p.stat().st_size for p in (tmp_path / "VERSIONS").iterdir())
    assert sizes == [3, 5] and (tmp_path / "VERSIONS" / "RF14_v1 (2).f3d").exists()


def test_a_design_opened_from_versions_saves_next_to_that_folder(tmp_path):
    assert addin.real_folder(str(tmp_path / "VERSIONS")) == str(tmp_path)
    assert addin.real_folder(str(tmp_path)) == str(tmp_path)


def test_the_preview_says_how_many_older_versions_will_move(tmp_path):
    for n in (1, 2, 3):
        _touch(tmp_path / f"RF14_v{n}.f3d")
    assert "3 older to VERSIONS" in addin.describe(*addin.planned_target(str(tmp_path), "RF14", True), moving=3)
    assert "older" not in addin.describe(*addin.planned_target(str(tmp_path), "RF14", True))


def test_the_first_version_takes_the_unversioned_file_to_versions_too(tmp_path):
    import json
    _touch(tmp_path / "BILOfix.f3d")
    _touch(tmp_path / ".meta" / "BILOfix.tree.json")
    _touch(tmp_path / "BILOfix Additional.f3d")                                            # another design whose name starts the same
    _touch(tmp_path / "BILOfix_v1.f3d")                                                    # the version that was just saved
    assert [Path(p).name for p in addin.movable_files(str(tmp_path), "BILOfix", str(tmp_path / "BILOfix_v1.f3d"))] == ["BILOfix.f3d"]
    assert addin.archive_versions(str(tmp_path), "BILOfix", keep=str(tmp_path / "BILOfix_v1.f3d")) == 1
    assert [p.name for p in (tmp_path / "VERSIONS").iterdir() if p.is_file()] == ["BILOfix.f3d"]
    assert [p.name for p in (tmp_path / "VERSIONS" / ".meta").iterdir()] == ["BILOfix.tree.json"]   # its hierarchy file went with it
    assert sorted(p.name for p in tmp_path.iterdir() if p.is_file()) == ["BILOfix Additional.f3d", "BILOfix_v1.f3d"]
    # the preview counts it, and the next version number is unaffected by an unversioned file in VERSIONS
    _touch(tmp_path / "BILOfix.f3d")
    assert len(addin.movable_files(str(tmp_path), "BILOfix", str(tmp_path / "BILOfix_v1.f3d"))) == 1
    assert addin.planned_target(str(tmp_path), "BILOfix", True)[0].endswith("BILOfix_v2.f3d")
    assert addin.archive_versions(str(tmp_path), "BILOfix", keep=str(tmp_path / "BILOfix_v2.f3d")) == 2   # BILOfix.f3d (taken name gets (2)) and v1
    assert sorted(p.name for p in (tmp_path / "VERSIONS").iterdir() if p.is_file()) == ["BILOfix (2).f3d", "BILOfix.f3d", "BILOfix_v1.f3d"]


def test_when_closing_a_document_loses_work_that_is_not_in_a_local_file():
    needs = addin.needs_local_copy
    assert needs(False, None, None, False, False) is False and needs(False, None, None, True, False) is False   # an empty document: never
    assert needs(False, None, "a", True, True) is True and needs(False, None, "a", False, True) is False         # a cloud document: Fusion's own modified flag
    assert needs(True, "a", "a", True, True) is False                                  # opened from a file and not changed: Fusion says modified, we know better
    assert needs(True, "a", "b", False, True) is True                                  # changed since the local copy was saved
    assert needs(True, None, "b", True, True) is True and needs(True, "a", None, False, True) is False          # no fingerprint: back to the modified flag
