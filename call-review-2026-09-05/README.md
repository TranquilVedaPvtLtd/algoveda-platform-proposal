# AlgoVeda engineering review, revision 2

Prepared 5 September 2026. The recording date is not independently verified.

The active review contains 15 engineering requirements. Seven unchanged requirements retain their revision-1 wording and can retain their existing approvals. Six changed requirements are revision 2 and need fresh review, including CALL-014, whose video feedback expands its previously approved scope. Two unchanged model-verification items remain separately scoped.

## Scope and history

- CALL-009, CALL-010, CALL-016 and CALL-017 move to the coordination appendix. Technical readiness, open-position and restart checks remain in CALL-008.
- CALL-012 is consolidated into CALL-011. The repeated AI requirements are consolidated into CALL-023, one skill accessible through existing JarvisDaily chat, without a new module or tab.
- Original requirement wording remains in the public manifest. Exact human comments remain in the authenticated review service only.
- The service returns removed-item review records as `archived_items`. The page shows them only after authenticated state loads, including linked historical feedback on the canonical item. They do not count toward engineering approval totals and have no new approval controls.
- JSON and readable exports contain the saved active and archived review records plus all original requirement versions. Exports require an authenticated, matching saved review. Treat downloaded feedback as private.

## Updating and verifying the document

Preserve stable IDs. Increment only changed item revisions and the document revision; update `config.json` too. Publish the same manifest to the review service and page together. A fingerprint mismatch blocks writing. Keep existing review storage so older comments, approvals and superseded items remain available.

Before publication, verify revision-1 approvals remain intact, changed items require review, archived feedback appears only after authentication, canonical items link inherited feedback, exports retain all histories, and ending the session removes private comments from the DOM. Check browser flows and stale-version behaviour against the matching service.

## Evidence and sources

The proposed quality mechanism cites official Zerodha, QuantConnect, AWS and Google SRE documentation. The page separates publisher-supported statements from adapted engineering checks. It does not claim the shared gate is already implemented, that the live strategy fleet passed, or that historical improvements guarantee future results.

Stored paper/live outcomes are comparison evidence, not future-known backtest answers. Proposed checks include time-correct inputs, fixed-entry comparison, separately reported entry-eligibility changes, cost-adjusted results, drawdown, preselected holdout data and an experiment log.

No credentials, reviewer links, raw recordings, transcripts, exact review comments or private account details belong in the public repository. Backend and publishing changes are managed separately.
