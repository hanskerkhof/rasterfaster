"""The text of the file list's filter box: several terms, matched against a file or folder name.

    PANEL S2          two terms: a name matches when it contains any of them (mode "any") or all of them (mode "all")
    "PANEL MOUNT"     a phrase in quotes is one term
    -copy             a name that contains this is left out (also -"a phrase")

Case does not matter. The same rules are in the frontend (`filter-terms.ts`), which highlights the terms in the list.
"""
import re
from typing import Literal

_token = re.compile(r'(-?)"([^"]*)"?|(-?)(\S+)')


def parse_query(query: str) -> tuple[list[str], list[str]]:
    """(terms that count, terms that exclude), lowercase. A lone `-` or an empty phrase is ignored."""
    include: list[str] = []
    exclude: list[str] = []
    for match in _token.finditer(query):
        minus = match.group(1) or match.group(3)
        text = (match.group(2) if match.group(2) is not None else match.group(4)).strip().lower()
        if not text or text == '-':  # nothing yet: a lone minus is the start of an exclusion that is still being typed
            continue
        (exclude if minus else include).append(text)
    return include, exclude


def name_matches(name: str, include: list[str], exclude: list[str], mode: Literal["any", "all"] = "any") -> bool:
    """Does the name satisfy the query? Nothing matches without a term that counts (`-copy` alone finds nothing)."""
    if not include:
        return False
    lower = name.lower()
    if any(term in lower for term in exclude):
        return False
    hits = (term in lower for term in include)
    return all(hits) if mode == "all" else any(hits)
