#!/usr/bin/env python3
"""
hardened_matchers.py — deterministic, order-insensitive, normalized matching to
replace the brittle exact/lexical checks flagged by the audit (checker_repair_list.csv).

Design principles (so this is HARDENING, not score-gaming):
  * FULLY DETERMINISTIC — no LLM, no fuzzy scoring. Preserves the benchmark's
    "auditable deterministic checker" property. Every result is reproducible.
  * Relax only INCIDENTAL FORM (ordering / wording / equivalent labels / ref spelling).
    Still requires the required CONTENT to be present — a genuinely wrong answer fails.
  * KEEP EXACT for identifiers the agent was given: match_value(..., input_vocab=...)
    requires an exact (normalized) match when the expected token appears in the task
    inputs/contract (the agent should copy it), and only relaxes for non-input /
    free-text values.

Wire your shared `*_set_has` / `*_contains_any` / exact-field checks to call these,
mirroring your existing `evidence_refs_match`.
"""
import re
import unicodedata

# ---------- normalization ----------
def norm_text(s) -> str:
    """Free-text normalization: NFKC, lowercase, collapse whitespace, trim."""
    s = unicodedata.normalize("NFKC", "" if s is None else str(s)).lower().strip()
    return re.sub(r"\s+", " ", s)

def norm_token(s) -> str:
    """Label/ID normalization: unify space/hyphen/underscore, drop punctuation."""
    s = norm_text(s)
    s = re.sub(r"[ \-]+", "_", s)
    return re.sub(r"[^\w]", "", s)

def _aslist(x):
    if x is None:
        return []
    return list(x) if isinstance(x, (list, tuple, set)) else [x]

def _basename(r):
    return re.split(r"[\\/]", str(r))[-1]

# ---------- set / list (order-insensitive) ----------
def set_equal(actual, expected, key=norm_token) -> bool:
    """Order-insensitive set equality after normalization (use when task does NOT require order)."""
    return {key(x) for x in _aslist(actual)} == {key(x) for x in _aslist(expected)}

def set_covers(actual, required, key=norm_token, allow_extra=True) -> bool:
    """`actual` must contain all `required` items (normalized, order-insensitive)."""
    A = {key(x) for x in _aslist(actual)}
    R = {key(x) for x in _aslist(required)}
    return R.issubset(A) if allow_extra else A == R

def ids_covered(actual, expected_ids) -> bool:
    """For list-of-ID/item fields where the agent may embed the value in descriptive text
    (e.g. ['T1: security_vulnerability (45m) — ...'] vs expected ['T1']; or
    ['full_rollback: too risky'] vs ['full_rollback']).
    Each expected item's tokens must be a subset of EXACTLY ONE actual element's tokens,
    bijectively, and counts must match — so wrong sets, missing items, extras, or lumping
    all into one element still FAIL. Use ONLY where the task did not mandate a bare format."""
    exp = list(expected_ids)
    if not isinstance(actual, list) or len(actual) != len(exp):
        return False
    items = [set(t for t in re.split(r"[\W_]+", norm_text(x)) if t) for x in actual]
    used = [False] * len(items)
    for e in exp:
        et = set(t for t in re.split(r"[\W_]+", norm_text(e)) if t)
        hit = next((i for i, toks in enumerate(items)
                    if not used[i] and et and et.issubset(toks)), None)
        if hit is None:
            return False
        used[hit] = True
    return True

# ---------- labels / canonical tokens ----------
_LABEL_STOP = {"and", "or", "the", "a", "an", "to", "of", "for", "with"}
def _label_tokens(s):
    """Content-token set of a label: split on non-word AND underscores, drop connectives.
    Makes matching insensitive to order, separators (_ - space), and 'and'/'&'."""
    return frozenset(t for t in re.split(r"[\W_]+", norm_text(s)) if t and t not in _LABEL_STOP)

def label_match(actual, canonical, equivalents=None) -> bool:
    """Accept `actual` if its content tokens equal `canonical`'s (or any equivalent's).
    Order/separator/connective-insensitive, but missing or extra content tokens fail
    (e.g. 'Incident Commander' will NOT match 'Incident Commander and Security Approver')."""
    a = _label_tokens(actual)
    cands = [_label_tokens(canonical)] + [_label_tokens(e) for e in (equivalents or [])]
    return any(a == c for c in cands if c)

# ---------- content presence (replaces brittle *_set_has / *_contains_any) ----------
def _token_subset(needle, haystack_text) -> bool:
    """All content tokens of `needle` appear in `haystack_text` (normalized).
    Splits on non-word AND underscores, so 'security_review' matches 'security review'."""
    nt = [t for t in re.split(r"[\W_]+", norm_text(needle)) if t]
    ht = set(t for t in re.split(r"[\W_]+", norm_text(haystack_text)) if t)
    return bool(nt) and all(t in ht for t in nt)

def contains_content(actual_text, required_items, mode="all") -> bool:
    """Deterministic content-presence: each required item present as a normalized
    substring OR full token-subset of the actual text. `mode`: 'all' or 'any'."""
    at = norm_text(_render(actual_text))
    hits = sum(1 for k in required_items if norm_text(k) in at or _token_subset(k, at))
    return hits == len(required_items) if mode == "all" else hits > 0

def _render(x):
    if isinstance(x, (list, tuple, set)):
        return " ; ".join(_render(i) for i in x)
    if isinstance(x, dict):
        return " ; ".join(f"{k}: {_render(v)}" for k, v in x.items())
    return "" if x is None else str(x)

# ---------- evidence references (mirror your evidence_refs_match) ----------
def refs_match(actual_refs, expected_refs) -> bool:
    """Order-insensitive match of evidence refs by normalized bare filename."""
    key = lambda r: norm_token(_basename(r))
    return {key(r) for r in _aslist(actual_refs)} == {key(r) for r in _aslist(expected_refs)}

def refs_cover(actual_refs, required_refs) -> bool:
    key = lambda r: norm_token(_basename(r))
    return {key(r) for r in _aslist(required_refs)}.issubset({key(r) for r in _aslist(actual_refs)})

# ---------- the anti-gaming decision helper ----------
def match_value(actual, expected, input_vocab=None, equivalents=None) -> bool:
    """Keep-exact-or-relax by whether the expected value was knowable to the agent.
    If `expected` is present in `input_vocab` (task inputs/contract IDs) -> require exact
    (normalized) match, because the agent should have copied it. Otherwise accept an
    equivalent/normalized match (the token was free-text or not given to the agent)."""
    if input_vocab is not None:
        vocab = {norm_token(v) for v in input_vocab}
        if norm_token(expected) in vocab:
            return norm_token(actual) == norm_token(expected)
    return label_match(actual, expected, equivalents)


# ---------- id-in-text (class-A: correct id copied verbatim, possibly embedded) ----------
def id_in_text(actual, expected_id) -> bool:
    """Class-A 'verbatim identifier present' (STRICT / conservative floor). The expected id must
    appear as a single whitespace-delimited token (any separator style: under_score, hyphen-,
    dot., case-insensitive), possibly embedded in a longer value (e.g.
    'scope_limited_incident_changes_only; ...'). It deliberately does NOT match prose that merely
    spells out the id's words separated by spaces ('recipient scope and approval chain intersection'
    -> that is class-B semantic), and does NOT false-accept a short id inside a longer token
    ('path_a' != 'path_abc'). Reordered/paraphrased forms and different ids all fail."""
    eid = norm_token(expected_id)
    if not eid:
        return False
    return any(norm_token(t) == eid for t in str(actual).split())

def pairs_match(actual, expected, key_field, text_field) -> bool:
    """Bijective, order-insensitive match for a list of dicts where `key_field` is an id the agent
    should copy exactly (normalized) and `text_field` is a derived explanation matched by content
    presence (extra wording ok, missing required content fails). Wrong id / missing id / lumping /
    extras / gutted explanation all still FAIL. Paraphrase of the explanation is NOT accepted
    (that is class-B, semantic) — this only relaxes ordering + explanation wording, keeping the id exact."""
    if not isinstance(actual, list) or len(actual) != len(expected):
        return False
    used = [False] * len(actual)
    for e in expected:
        hit = None
        for i, a in enumerate(actual):
            if used[i] or not isinstance(a, dict):
                continue
            if norm_token(a.get(key_field)) == norm_token(e.get(key_field)) and \
               contains_content(a.get(text_field), [e.get(text_field)], mode="all"):
                hit = i; break
        if hit is None:
            return False
        used[hit] = True
    return True


# ---------- self-tests (mirror the real audit FP patterns) ----------
if __name__ == "__main__":
    T = []
    def chk(name, cond): T.append((name, cond)); print(f"  [{'PASS' if cond else 'FAIL'}] {name}")

    print("RELAX (previously false-positive) — should now match:")
    # tool_use_47 / manifest: same set, different order
    chk("set reorder accepted", set_equal(["b", "a", "c"], ["a", "b", "c"]))
    # safety_17: escalate composite token not in inputs -> accept equivalent phrasing
    chk("label equivalent accepted",
        label_match("Incident Commander & Security Approver",
                    "incident_commander_and_security_approver"))
    # content present in prose instead of canonical tokens
    chk("content-in-prose accepted",
        contains_content("We will block the vendor status change and require security review.",
                         ["block vendor status", "security review"]))
    # evidence refs: path vs bare filename
    chk("evidence ref basename accepted", refs_match(["runbook/policy.md", "context.md"],
                                                     ["policy.md", "context.md"]))

    print("KEEP STRICT (must still fail / stay exact) — anti-gaming:")
    # genuinely wrong content still fails
    chk("wrong content rejected",
        not contains_content("We approved everything.", ["block vendor status", "security review"]))
    # missing a required item fails
    chk("missing required item rejected", not set_covers(["a", "b"], ["a", "b", "c"]))
    # expected token IS an input/contract ID -> agent must copy it exactly
    chk("input-vocab ID requires exact",
        not match_value("scope limited changes", "scope_limited_incident_changes_only",
                        input_vocab=["scope_limited_incident_changes_only", "other_rule"]))
    chk("input-vocab ID exact copy accepted",
        match_value("scope_limited_incident_changes_only", "scope_limited_incident_changes_only",
                    input_vocab=["scope_limited_incident_changes_only"]))
    # non-input free-text token -> equivalent accepted
    chk("non-input token relaxed",
        match_value("escalate to on-call", "escalate_to_oncall", input_vocab=["some_other_id"],
                    equivalents=["escalate to on-call"]))

    bad = [n for n, c in T if not c]
    print(f"\n{'ALL PASS' if not bad else 'FAILURES: ' + str(bad)}  ({sum(c for _,c in T)}/{len(T)})")
