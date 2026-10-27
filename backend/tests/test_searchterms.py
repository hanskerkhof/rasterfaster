import pytest
from fastapi.testclient import TestClient

import main
import searchterms

EXAMPLES = [
    "BOLT FEET S2.stl",
    "USB-C PANEL MOUNT_RF2 v636_WS2812B BACK WITH GLUE (1).stl",
    "5.22 - 6w - FRONT - Digital Voltmeter Amperemeter Panel.stl",
]


def test_terms_are_split_on_spaces_and_lowercased():
    assert searchterms.parse_query("PANEL S2") == (["panel", "s2"], [])
    assert searchterms.parse_query("  panel   s2 ") == (["panel", "s2"], [])
    assert searchterms.parse_query("") == ([], []) and searchterms.parse_query("   ") == ([], [])


def test_quotes_make_a_phrase_and_a_minus_leaves_a_term_out():
    assert searchterms.parse_query('"PANEL MOUNT" s2') == (["panel mount", "s2"], [])
    assert searchterms.parse_query('panel -copy -"old part"') == (["panel"], ["copy", "old part"])
    assert searchterms.parse_query('"unfinished phrase') == (["unfinished phrase"], [])        # a missing closing quote runs to the end
    assert searchterms.parse_query('panel - ""') == (["panel"], [])                           # a lone minus and an empty phrase count for nothing
    assert searchterms.parse_query("a-b") == (["a-b"], [])                                    # a minus inside a word is part of the word


def test_any_mode_finds_the_three_examples_all_mode_only_the_one_with_both():
    include, exclude = searchterms.parse_query("PANEL S2")
    assert [searchterms.name_matches(n, include, exclude, "any") for n in EXAMPLES] == [True, True, True]
    assert [searchterms.name_matches(n, include, exclude, "all") for n in EXAMPLES] == [False, True, False]
    assert not searchterms.name_matches("RANDOM.stl", include, exclude, "any")


def test_exclusions_and_nothing_to_find():
    include, exclude = searchterms.parse_query("panel -glue")
    assert [searchterms.name_matches(n, include, exclude) for n in EXAMPLES] == [False, False, True]
    assert searchterms.name_matches("anything", *searchterms.parse_query("-glue")) is False   # no term that counts: nothing matches
    assert searchterms.name_matches("Panel mount", *searchterms.parse_query('"PANEL MOUNT"')) is True
    assert searchterms.name_matches("Panel  mount", *searchterms.parse_query('"PANEL MOUNT"')) is False   # a phrase is matched as typed


@pytest.fixture
def search_client(tmp_path, monkeypatch):
    library = (tmp_path / "lib").resolve()
    for folder, name in (("1.8.FEET - APPARAAT VOET", EXAMPLES[0]), ("MOUNTS/3.8.USB", EXAMPLES[1]), ("MOUNTS/3.37 PSU", EXAMPLES[2]), ("", "UNRELATED.stl")):
        (library / folder).mkdir(parents=True, exist_ok=True)
        (library / folder / name).write_bytes(b"x")
    monkeypatch.setattr(main, "libraryRoot", library)
    return TestClient(main.app)


def _files(client, **params):
    return sorted(e["name"] for e in client.get("/api/search", params=params).json() if e["type"] == "file")


def test_api_search_any_all_phrase_and_exclusion(search_client):
    assert _files(search_client, q="PANEL S2") == sorted(EXAMPLES)                              # any: the three, not UNRELATED
    assert _files(search_client, q="PANEL S2", mode="all") == [EXAMPLES[1]]
    assert _files(search_client, q="panel -glue") == [EXAMPLES[2]]
    assert _files(search_client, q='"USB-C PANEL"') == [EXAMPLES[1]]
    assert _files(search_client, q="-glue") == [] and _files(search_client, q="") == []
    assert search_client.get("/api/search", params={"q": "x", "mode": "most"}).status_code == 422
