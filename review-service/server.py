#!/usr/bin/env python3
"""One-document review API. No trading clients, credentials, or endpoints."""

import hashlib
import hmac
import json
import os
import re
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

PREFIX = "/reviews-api"
PUBLIC_ORIGIN = "https://tranquilvedapvtltd.github.io"
MAX_BODY = 128 * 1024
MAX_COMMENT = 4000
MAX_BATCH = 28
MAX_ITEMS = 500
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def valid_revision(value):
    return ((type(value) is int and value > 0) or
            (type(value) is str and 0 < len(value) <= 128 and value.strip() == value))


class APIError(Exception):
    def __init__(self, status, code, message, snapshot=None):
        super().__init__(message)
        self.status = status
        self.body = {"error": code, "message": message}
        if snapshot is not None:
            self.body["state"] = snapshot


def load_manifest(path):
    try:
        with open(path, encoding="utf-8") as source:
            raw = json.load(source)
        document_id = raw["document_id"]
        revision = raw["document_revision"]
        requirements = raw["requirements"]
        assert type(document_id) is str and IDENTIFIER.fullmatch(document_id)
        assert valid_revision(revision)
        assert type(requirements) is list and 1 <= len(requirements) <= MAX_ITEMS
        items = {}
        for item in requirements:
            item_id = item["id"]
            assert type(item_id) is str and IDENTIFIER.fullmatch(item_id)
            assert item_id not in items
            assert type(item["revision"]) is int and item["revision"] > 0
            items[item_id] = {
                "revision": item["revision"], "fingerprint": fingerprint(item),
                "clarification_required": bool(item.get("clarification_required") or item.get("comments_needed")),
            }
        return {"document_id": document_id, "revision": revision, "items": items,
                "fingerprint": fingerprint({"document_revision": revision, "items": items})}
    except (OSError, ValueError, KeyError, TypeError, AssertionError):
        raise APIError(503, "manifest_unavailable", "The review document is temporarily unavailable.") from None


class ReviewStore:
    def __init__(self, database, manifest_path):
        self.database = str(database)
        self.manifest_path = str(manifest_path)
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as connection:
            connection.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS document (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    document_id TEXT NOT NULL, revision TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, version INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS items (
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
                    fingerprint TEXT NOT NULL, status TEXT NOT NULL,
                    active INTEGER NOT NULL, clarification_required INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                    item_id TEXT NOT NULL, action TEXT NOT NULL, text TEXT,
                    at TEXT NOT NULL, document_revision TEXT NOT NULL,
                    item_revision INTEGER NOT NULL, item_fingerprint TEXT NOT NULL,
                    request_id TEXT
                );
                CREATE INDEX IF NOT EXISTS events_item ON events(item_id, seq);
                CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
                    manifest_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL
                );
                CREATE TRIGGER IF NOT EXISTS immutable_events_update
                    BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only events'); END;
                CREATE TRIGGER IF NOT EXISTS immutable_events_delete
                    BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'append-only events'); END;
            """)

    def connect(self):
        connection = sqlite3.connect(self.database, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    @staticmethod
    def event(connection, item_id, action, text, manifest, request_id=None, at=None):
        connection.execute(
            "INSERT INTO events(id,item_id,action,text,at,document_revision,item_revision,item_fingerprint,request_id) VALUES(?,?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), item_id, action, text, at or now(), canonical(manifest["revision"]),
             manifest["items"][item_id]["revision"], manifest["items"][item_id]["fingerprint"], request_id),
        )

    def sync(self, connection, manifest):
        document = connection.execute("SELECT * FROM document").fetchone()
        at = now()
        if document is None:
            connection.execute("INSERT INTO document VALUES(1,?,?,?,?,?)",
                               (manifest["document_id"], canonical(manifest["revision"]),
                                manifest["fingerprint"], 0, at))
        elif document["document_id"] != manifest["document_id"]:
            raise APIError(503, "manifest_mismatch", "The review document needs a support check.")
        elif document["fingerprint"] == manifest["fingerprint"]:
            return
        previous = {row["id"]: row for row in connection.execute("SELECT * FROM items")}
        for item_id, item in manifest["items"].items():
            old = previous.get(item_id)
            if old is None:
                connection.execute("INSERT INTO items VALUES(?,?,?,'pending',1,?)",
                                   (item_id, item["revision"], item["fingerprint"], int(item["clarification_required"])))
            elif not old["active"] or old["fingerprint"] != item["fingerprint"]:
                connection.execute("UPDATE items SET revision=?,fingerprint=?,status='pending',active=1,clarification_required=? WHERE id=?",
                                   (item["revision"], item["fingerprint"], int(item["clarification_required"]), item_id))
                self.event(connection, item_id, "revision_changed", "The requirement changed and needs a fresh review.", manifest, at=at)
        for item_id in previous.keys() - manifest["items"].keys():
            connection.execute("UPDATE items SET active=0,status='pending' WHERE id=?", (item_id,))
        if document is not None:
            connection.execute("UPDATE document SET revision=?,fingerprint=?,version=version+1,updated_at=? WHERE singleton=1",
                               (canonical(manifest["revision"]), manifest["fingerprint"], at))

    @staticmethod
    def snapshot(connection):
        document = connection.execute("SELECT * FROM document").fetchone()
        items = {}
        for row in connection.execute("SELECT * FROM items WHERE active=1 ORDER BY id"):
            history, comments = [], []
            for event in connection.execute("SELECT * FROM events WHERE item_id=? ORDER BY seq", (row["id"],)):
                record = {"id": event["id"], "action": event["action"], "at": event["at"],
                          "document_revision": json.loads(event["document_revision"]), "revision": event["item_revision"],
                          "fingerprint": event["item_fingerprint"]}
                if event["text"]:
                    record["text"] = event["text"]
                    if event["action"] in {"comment", "request_changes", "resolution", "reopen"}:
                        comments.append({"id": event["id"], "text": event["text"], "at": event["at"],
                                         "kind": event["action"], "revision": event["item_revision"]})
                history.append(record)
            unresolved = connection.execute("SELECT action FROM events WHERE item_id=? AND action IN ('request_changes','comment','resolution') ORDER BY seq DESC LIMIT 1", (row["id"],)).fetchone()
            items[row["id"]] = {"status": row["status"], "revision": row["revision"],
                                "fingerprint": row["fingerprint"],
                                "clarification_required": bool(row["clarification_required"]),
                                "resolution_required": bool(row["clarification_required"] or (unresolved and unresolved["action"] != "resolution")),
                                "comments": comments, "history": history}
        return {"document_id": document["document_id"], "document_revision": json.loads(document["revision"]),
                "version": document["version"], "items": items, "updated_at": document["updated_at"]}

    def get_state(self, document_id):
        manifest = load_manifest(self.manifest_path)
        if document_id != manifest["document_id"]:
            raise APIError(404, "unknown_document", "This review document was not found.")
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            self.sync(connection, manifest)
            snapshot = self.snapshot(connection)
            connection.commit()
            return snapshot
        finally:
            connection.close()

    def review(self, payload):
        manifest = load_manifest(self.manifest_path)
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            self.sync(connection, manifest)
            try:
                actions, replay = self.validate(connection, manifest, payload)
            except APIError:
                # Manifest changes must remain visible even when an old browser submits.
                connection.commit()
                raise
            if replay:
                # The action is never applied twice. Return current state, not stale approval.
                result = self.snapshot(connection)
                connection.commit()
                return result
            at = now()
            for item in actions:
                if item["resolution"]:
                    self.event(connection, item["id"], "resolution", item["resolution"], manifest, payload["request_id"], at)
                self.event(connection, item["id"], item["action"], item["comment"], manifest, payload["request_id"], at)
                status = {"approve": "approved", "request_changes": "changes_requested",
                          "comment": "changes_requested", "reopen": "pending"}[item["action"]]
                if item["action"] == "reopen":
                    unresolved = connection.execute("SELECT action FROM events WHERE item_id=? AND action IN ('request_changes','comment','resolution') ORDER BY seq DESC LIMIT 1", (item["id"],)).fetchone()
                    if unresolved and unresolved["action"] != "resolution":
                        status = "changes_requested"
                connection.execute("UPDATE items SET status=? WHERE id=?", (status, item["id"]))
            connection.execute("UPDATE document SET version=version+1,updated_at=? WHERE singleton=1", (at,))
            result = self.snapshot(connection)
            connection.execute("INSERT INTO requests VALUES(?,?,?,?)",
                               (payload["request_id"], fingerprint(payload), manifest["fingerprint"], canonical(result)))
            connection.commit()
            return result
        finally:
            connection.close()

    def validate(self, connection, manifest, payload):
        def invalid(message="Please check the review details and try again."):
            raise APIError(400, "invalid_request", message)

        def conflict(code, message):
            raise APIError(409, code, message, self.snapshot(connection))

        required = {"document_id", "document_revision", "expected_version", "request_id", "actions"}
        if type(payload) is not dict or set(payload) != required:
            invalid()
        if payload["document_id"] != manifest["document_id"]:
            raise APIError(404, "unknown_document", "This review document was not found.")
        if not valid_revision(payload["document_revision"]) or canonical(payload["document_revision"]) != canonical(manifest["revision"]):
            conflict("document_changed", "The document changed. Reload it before reviewing.")
        request_id = payload["request_id"]
        if type(request_id) is not str or not IDENTIFIER.fullmatch(request_id):
            invalid()
        if type(payload["expected_version"]) is not int or payload["expected_version"] < 0:
            invalid()
        existing = connection.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
        if existing:
            if existing["payload_hash"] != fingerprint(payload):
                conflict("request_reused", "This submission ID already belongs to a different change.")
            if existing["manifest_fingerprint"] != manifest["fingerprint"]:
                conflict("document_changed", "The requirement changed. Reload it before reviewing.")
            return [], True
        if payload["expected_version"] != connection.execute("SELECT version FROM document").fetchone()[0]:
            conflict("version_conflict", "Someone updated this review. Your change was not saved. Check the latest version and try again.")
        actions = payload["actions"]
        if type(actions) is not list or not 1 <= len(actions) <= MAX_BATCH:
            invalid("A submission must contain between 1 and 28 review actions.")
        seen, normalized = set(), []
        for item in actions:
            if type(item) is not dict or not {"id", "action", "revision"} <= set(item) or set(item) - {"id", "action", "revision", "comment", "resolution", "fingerprint"}:
                invalid()
            item_id, action = item["id"], item["action"]
            if type(item_id) is not str or item_id not in manifest["items"] or item_id in seen:
                invalid("Choose each current requirement at most once per submission.")
            seen.add(item_id)
            if type(item["revision"]) is not int or item["revision"] != manifest["items"][item_id]["revision"]:
                conflict("item_changed", "This requirement changed. Reload it before reviewing.")
            if "fingerprint" in item and item["fingerprint"] != manifest["items"][item_id]["fingerprint"]:
                conflict("item_changed", "The displayed wording changed. Reload it before reviewing.")
            if type(action) is not str or action not in {"approve", "request_changes", "comment", "reopen"}:
                invalid()
            comment, resolution = item.get("comment", ""), item.get("resolution", "")
            if type(comment) is not str or type(resolution) is not str or max(len(comment), len(resolution)) > MAX_COMMENT:
                invalid("Comments must be text, with at most 4,000 characters.")
            comment, resolution = comment.strip(), resolution.strip()
            if action in {"comment", "request_changes"} and not comment:
                invalid("Please explain the comment or requested change.")
            if resolution and action != "approve":
                invalid("A revalidation explanation belongs with an approval.")
            if action == "approve":
                if comment:
                    invalid("Use the revalidation explanation with approval, or save a comment separately.")
                row = connection.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
                unresolved = connection.execute("SELECT action FROM events WHERE item_id=? AND action IN ('request_changes','comment','resolution') ORDER BY seq DESC LIMIT 1", (item_id,)).fetchone()
                if row["clarification_required"] and len(actions) > 1:
                    invalid("Approve requirements needing clarification individually, with a recorded explanation.")
                if (row["status"] == "changes_requested" or row["clarification_required"] or (unresolved and unresolved["action"] != "resolution")) and not resolution:
                    invalid("Record the clarification or explain how the requested changes were rechecked before approving.")
            normalized.append({"id": item_id, "action": action, "comment": comment, "resolution": resolution})
        return normalized, False


def allowed_origin(origin, allow_localhost=False):
    if origin == PUBLIC_ORIGIN:
        return True
    if allow_localhost and origin:
        try:
            parsed = urlsplit(origin)
            return (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
                    and not parsed.username and not parsed.password and not parsed.path
                    and not parsed.query and not parsed.fragment)
        except ValueError:
            return False
    return False


def make_handler(store, token_hash, allow_localhost=False):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", token_hash):
        raise ValueError("REVIEW_TOKEN_SHA256 must be a SHA-256 hex digest")
    token_hash = token_hash.lower()

    class Handler(BaseHTTPRequestHandler):
        server_version = "ReviewService"
        sys_version = ""

        def log_message(self, format, *args):
            # No URL, query, headers, token, body, or client comments in access logs.
            return

        def send_json(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Vary", "Origin")
            origin = self.headers.get("Origin")
            if allowed_origin(origin, allow_localhost):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
            self.wfile.write(data)

        def authorize(self):
            origin = self.headers.get("Origin")
            if origin is not None and not allowed_origin(origin, allow_localhost):
                raise APIError(403, "origin_denied", "This website cannot access the review.")
            authorization = self.headers.get("Authorization", "")
            token = authorization[7:] if authorization.startswith("Bearer ") else ""
            digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
            if not token or len(token) > 2048 or not hmac.compare_digest(digest, token_hash):
                raise APIError(401, "unauthorized", "Open the private review link to continue.")

        def do_OPTIONS(self):
            if not allowed_origin(self.headers.get("Origin"), allow_localhost):
                self.send_json(403, {"error": "origin_denied"})
                return
            if urlsplit(self.path).path not in {PREFIX + "/state", PREFIX + "/review"}:
                self.send_json(404, {"error": "not_found"})
                return
            self.send_json(200, {"ok": True})

        def do_GET(self):
            self.dispatch("GET")

        def do_POST(self):
            self.dispatch("POST")

        def dispatch(self, method):
            try:
                route = urlsplit(self.path)
                if method == "GET" and route.path == PREFIX + "/health":
                    # Only availability; no document ID, review data, or secret state.
                    load_manifest(store.manifest_path)
                    self.send_json(200, {"ok": True})
                    return
                self.authorize()
                if method == "GET" and route.path == PREFIX + "/state":
                    query = parse_qs(route.query)
                    if set(query) != {"document_id"} or len(query["document_id"]) != 1:
                        raise APIError(400, "invalid_request", "Choose a review document.")
                    result = store.get_state(query["document_id"][0])
                elif method == "POST" and route.path == PREFIX + "/review" and not route.query:
                    if self.headers.get_content_type() != "application/json":
                        raise APIError(415, "content_type", "Send review changes as JSON.")
                    if self.headers.get("Transfer-Encoding"):
                        raise APIError(400, "invalid_request", "A request size is required.")
                    lengths = self.headers.get_all("Content-Length", [])
                    if len(lengths) != 1 or not lengths[0].isdigit():
                        raise APIError(411, "length_required", "A request size is required.")
                    length = int(lengths[0])
                    if not 1 <= length <= MAX_BODY:
                        raise APIError(413, "too_large", "The review submission is too large.")
                    self.connection.settimeout(15)
                    content = self.rfile.read(length)
                    if len(content) != length:
                        raise APIError(400, "invalid_json", "The submission was incomplete.")
                    try:
                        payload = json.loads(content.decode("utf-8"))
                    except (ValueError, UnicodeError):
                        raise APIError(400, "invalid_json", "The submission could not be read.") from None
                    result = store.review(payload)
                else:
                    raise APIError(404, "not_found", "This review endpoint was not found.")
                self.send_json(200, result)
            except APIError as error:
                self.send_json(error.status, error.body)
            except (sqlite3.Error, OSError, ValueError):
                self.send_json(503, {"error": "temporarily_unavailable", "message": "The review could not be saved. Please retry shortly."})

    return Handler


def main():
    store = ReviewStore(os.environ.get("REVIEW_DATABASE", "/data/reviews.sqlite3"),
                        os.environ.get("REVIEW_MANIFEST", "/app/requirements.json"))
    handler = make_handler(store, os.environ.get("REVIEW_TOKEN_SHA256", ""),
                           os.environ.get("REVIEW_ALLOW_LOCALHOST") == "1")
    server = ThreadingHTTPServer((os.environ.get("REVIEW_BIND", "0.0.0.0"),
                                 int(os.environ.get("REVIEW_PORT", "8100"))), handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
