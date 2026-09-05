# AlgoVeda requirements review

Prepared 5 September 2026 from the complete Marathi and English call transcript.
The public document contains sanitized requirements and source section timestamps.
The recording, transcript, private account details, review access token and feedback database are not published in this repository.

## Review

Open the private reviewer link supplied with the document. The ordinary page URL
shows the requirements in read-only mode. The reviewer link permits approvals,
comments and exports for this document only. Keep that link with the intended reviewers.

1. Read a requirement and expand its completion checks and source notes.
2. Approve the wording, or add a comment describing the required change.
3. Comments reopen the item. After clarification, record how the comment was
   resolved and revalidate the requirement. Feedback remains in its history.
4. Use the approved-plan export as the input to the implementation plan.

Requirement approval is a scope decision. Implementation status and production
readiness require their own evidence. A linked tracker change is not automatically
accepted merely because it was merged.

## Updating requirements after feedback

Edit `requirements.json` and preserve each existing requirement ID. Increment the
changed item's `revision` and the document's `document_revision`; update the latter
in `config.json` too. Publish the same manifest to the review service before the
Pages release. The service also fingerprints content so an accidental wording
change without a revision bump cannot retain an old approval.

Deploy the service manifest and page together. A stale page is prevented from
writing reviews. Retain the review database when replacing the service container.
Never place credentials, reviewer links, raw transcripts or database files in Git.

## Coordination with ongoing tracker work

The document links related tracker rows and pull requests using a dated snapshot.
Before implementation, check their latest state and validate against the acceptance
checks here. Avoid opening a duplicate change when an existing change already
addresses the requirement. Keep remaining gaps visible until reviewed.

## Sources

- 27 requirements were extracted from the call, covering all 13 spoken sections.
- One separately labelled item records the earlier instruction about using both
  preferred models and falling back only when they are unavailable.
- Concrete tests and safeguards added during extraction are labelled as proposed.
- Relative dates, numerical examples and unverified explanations are preserved as
  decisions or questions instead of being converted into promises.
