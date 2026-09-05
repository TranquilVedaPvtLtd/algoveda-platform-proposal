# Call review service

This service saves approvals and comments for one public requirements document. It has no trading integration and needs no trading credentials. Python 3.10+ and its standard library are sufficient.

Run the isolated test suite from the repository root:

```sh
python3 -m unittest discover -s review-service -p 'test_*.py' -v
```

## Runtime

Set these environment values for the process or container:

| Variable | Value |
| --- | --- |
| `REVIEW_TOKEN_SHA256` | SHA-256 hex digest of a strong, private review token. Required. |
| `REVIEW_DATABASE` | `/data/reviews.sqlite3` by default. Mount a durable writable directory. |
| `REVIEW_MANIFEST` | Path to the deployed public `requirements.json`. Defaults to `/app/requirements.json`. |
| `REVIEW_PORT` | `8100` by default. Keep this on the private proxy network. |
| `REVIEW_BIND` | `0.0.0.0` by default. Use `127.0.0.1` for a direct local process. |
| `REVIEW_ALLOW_LOCALHOST` | Leave unset in production. `1` additionally permits HTTP loopback origins for local tests. |

The production CORS origin is exactly `https://tranquilvedapvtltd.github.io`. A browser gets the token from the private link fragment and sends it in `Authorization: Bearer ...`. The service never accepts a query token, logs the token, or exposes review data through its health endpoint. The token is a shared reviewer capability, not individual identity; history records actions and times, without claiming which person submitted them.

An isolated container can use the existing `python:3.12-alpine` image, a read-only application mount, a read-only document directory mount, and a separate writable `/data` mount. Start `python /app/server.py` with the environment above on the existing private Caddy network. Do not publish port 8100. Mount the **document directory**, rather than an individual manifest file, so an atomic file replacement is visible to the running process.

Add this narrow Caddy route before the site's static catchall; preserve all existing virtual hosts and routes:

```caddy
handle /reviews-api/* {
    reverse_proxy jd-client-reviews:8100
}
```

There is no prefix rewrite. Validate the updated Caddy configuration before reloading. Check `GET /reviews-api/health` without credentials, then verify an authenticated state read. Use an isolated test database to verify writes; do not add synthetic approvals to the customer's document.

## API and review rules

- `GET /reviews-api/health` returns `{ "ok": true }` when the manifest is readable and valid. It contains no document or review state. It is not a database durability check.
- `GET /reviews-api/state?document_id=...` returns the document ID/revision, state version, update time, and current items. Each item includes its revision, full-content SHA-256 `fingerprint`, status, clarification/resolution flags, comments, and event history.
- `POST /reviews-api/review` accepts `document_id`, `document_revision`, `expected_version`, `request_id`, and `actions`. Each action has `id`, `revision`, `action`, and optional `fingerprint`, `comment`, or `resolution`. Valid actions are `approve`, `request_changes`, `comment`, and `reopen`.
- The frontend sends the fingerprint of the wording it displays. A mismatch returns 409. It must also compare its local requirements with the server state before enabling review actions.
- A state-version conflict returns 409 with the latest snapshot under `state`; no submitted action is applied. Show the conflict, preserve the user's draft, and ask them to review the current state before resubmitting with a fresh request ID.
- Retry an uncertain network submission using the same request ID and exactly the same payload. It is applied at most once. A retry returns the **current** snapshot, so intervening comments are never replaced by an older approval view. Reusing the ID for another payload returns 409.
- Comments and requested changes set `changes_requested`. Approval needs a nonempty `resolution` until that feedback has been addressed. Reopening cannot clear an unresolved comment or change request. A resolution is retained as a separate event and comment beside the approval.
- Items marked `clarification_required` or `comments_needed` require an individual approval with a resolution; they cannot be approved as part of a batch. An approval cannot silently include an ordinary comment: save the comment separately or put the revalidation explanation in `resolution`.
- Requests are limited to 128 KiB, 28 distinct actions, and 4,000 characters per comment or resolution. Manifests may contain up to 500 distinct items. The database applies a valid batch in one transaction or applies none of its actions.

## Document changes, backups, and rollback

Publish a manifest with a stable `document_id`, an explicit `document_revision`, and an integer `revision` for every requirement. Bump item revisions when editing requirements and bump the document revision for a new published document. The service also hashes all fields of each item, so an accidental wording change without a revision bump still withdraws the affected approval. Other unchanged item approvals remain valid. Old comments and approval fingerprints remain in the append-only event history. Removed items disappear from the current view while their history is retained. Reintroducing an item requires a fresh review.

Manifest changes increment the shared state version. An old document revision, item revision, content fingerprint, or state version is rejected. A changed manifest is imported before that conflict is returned, so other viewers can immediately see the need for another review. A malformed manifest fails closed without deleting existing reviews. This service is intentionally restricted to its original document ID; use a separate database for another document.

SQLite uses WAL and full synchronization. Back up using Python's `sqlite3.Connection.backup()` while the service is running, or stop the container before copying the database and its WAL files together. Copying only the live `.sqlite3` file can miss committed reviews. Keep backups outside the public static site; comments and the database are private.

For rollback, stop only this review container and restore the matching application, manifest, and SQLite backup after preserving the current database. Do not discard new customer decisions without first reconciling them from the retained snapshot and event history. Revert only the `/reviews-api/*` Caddy route if removing the service. Existing website and trading services do not need changes. Rotate the token by replacing its configured digest and recreating this container; distribute the new private fragment link separately.
