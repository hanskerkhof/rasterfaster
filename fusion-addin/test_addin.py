"""Tests of the file naming and version logic of the add-in (Fusion's own modules are replaced by stand-ins)."""
import sys
import types
from pathlib import Path

for name in ("adsk", "adsk.core", "adsk.fusion"):
    module = types.ModuleType(name)
    sys.modules[name] = module
sys.modules["adsk"].core = sys.modules["adsk.core"]
sys.modules["adsk"].fusion = sys.modules["adsk.fusion"]
for handler in ("CommandCreatedEventHandler", "CommandEventHandler", "InputChangedEventHandler"):
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
