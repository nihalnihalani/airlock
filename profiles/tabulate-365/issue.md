tabulate raises IndexError for an empty table when maxheadercolwidths is set

from tabulate import tabulate
print(tabulate([], headers=["Name", "Value"], maxheadercolwidths=5))

Traceback (most recent call last):
  File "tabulate/__init__.py", line 2291, in tabulate
    num_cols = len(list_of_lists[0])
IndexError: list index out of range

Expected: the header-only table, as without maxheadercolwidths.

(python-tabulate issue #365: https://github.com/astanin/python-tabulate/issues/365)

<!--
Provenance: this is NOT a verbatim copy of the upstream issue text; the original text is not in
this repository. It is a faithful minimal description written from the profile's own evidence:
the reported case in profiles/tabulate-365/contract.json (empty tabular_data, headers
["Name", "Value"], maxheadercolwidths=5 raises IndexError "list index out of range" at the
baseline commit) and the failing frame recorded in research/22-feasibility-lab.md (E04,
tabulate/__init__.py:2291, `num_cols = len(list_of_lists[0])`). It names no fix and no commit.
It is the default --issue of scripts/live-gate.ts.
-->
