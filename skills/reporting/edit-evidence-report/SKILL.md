---
name: edit-evidence-report
description: Use when writing or revising a FlowLens investigation report for human readers, especially when a draft is repetitive, hard to scan or dominated by transaction dumps.
---

# Edit an evidence report

Use after [evidence review](../../investigation/audit-trace-evidence/SKILL.md), before [document export](../report-investigation/SKILL.md). Edit existing evidence; new queries and stronger attribution require their own justification.

## Reader section

Write a decision memo with this reading order:

1. **Finding:** answer, qualitative confidence, claim scope and major coverage limit in one short paragraph. Distinguish operational affiliation, control and beneficial ownership. An unresolved finding is valid.
2. **Deciding evidence:** usually three to five evidence groups, including the strongest countercase. Each group gives a concrete observation, evidence type/source, reference and its effect on the comparison. Group by the claim being tested, not by every raw record. An article and its underlying channel form one attribution group; several receipts may form one payment-relationship group.
3. **Critical chronology:** when timing affects causation, show the relevant dated, directed flows once. A later upstream payment cannot explain an earlier downstream payment as the same funds. Reference this timeline from the comparison.
4. **Open questions:** the few missing disclosures, control joins or destination credits that could change the finding. Distinguish service boundaries, partial history, actual blockers and unresolved wallets.

Aim for a roughly two-minute opening read. Add reader-section detail when it changes the decision; let the technical appendix carry record-level volume. Preserve all material contrary evidence.

## Evidence presentation

- Use descriptive roles and short address suffixes in prose; define full addresses once in the register.
- Show exact readable amounts, asset, chain, UTC and short transaction references. Link their source entries. Put full hashes, raw integers, decimals, contracts, blocks and event indexes in one technical ledger.
- Mark **on-chain fact**, **calculation**, **provider assertion**, **third-party attribution** and **inference** accurately. Verify each decisive claim against retained records.
- Explain source dependence once per attribution group. A screenshot observes its source; it is not independent corroboration.
- Preserve useful proof screenshots when shortening prose. Build a visual sequence covering the exact-target claim, label provenance, key transfers and the strongest countercase. Let complementary figures add pages; remove a figure for redundancy, poor readability, privacy or unsupported provenance, not merely to shorten the report.
- State a general qualification once. Later entries carry only their distinct limitation. Reference evidence IDs instead of repeating the same fact across summary, scorecard, timeline and conclusion.

## Technical appendix and export

Attach the exact ledger, addresses, source/capture times and checksums in the report or a clearly delivered companion. A pointer to an undelivered private file is insufficient. Preserve the full research case and audit manifest; label a reader edition's source revision, selection scope and omissions. A filtered case needs its own identity. Case attachments and exporter disclaimers must describe what is actually delivered.

Use [claim and layout checks](references/claim-and-layout.md) for manifest preparation. Follow the export skill for privacy, hashes and all-page review. Real examples stay under `.local/`; public skills contain methodology only.

## Acceptance check

A reader can identify the answer, strongest fact, strongest counterfact and major gap before the inventory. Each decisive reference reaches retained proof. Inspect the actual exported pages, including generated tables and boilerplate, for duplication, readable wrapping and accurate scope. Report any unresolved source or rendering limit.
