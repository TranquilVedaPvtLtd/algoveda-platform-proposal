"""Hermetic durable review tests; no customer or production data is written."""

import hashlib
import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from server import APIError, MAX_BODY, PUBLIC_ORIGIN, ReviewStore, ThreadingHTTPServer, make_handler


class ReviewFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.manifest_path = self.directory / "requirements.json"
        self.manifest = {"document_id": "test-review", "document_revision": 1,
                         "requirements": [{"id": "CALL-001", "revision": 1, "title": "First item", "requested_outcome": "A"},
                                          {"id": "CALL-002", "revision": 1, "title": "Second item", "comments_needed": True}]}
        self.save_manifest()
        self.database = self.directory / "reviews.sqlite3"
        self.store = ReviewStore(self.database, self.manifest_path)

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")

    def state(self):
        return self.store.get_state("test-review")

    def payload(self, actions=None, version=None, request_id=None):
        return {"document_id": "test-review", "document_revision": self.manifest["document_revision"],
                "expected_version": self.state()["version"] if version is None else version,
                "request_id": request_id or str(uuid.uuid4()),
                "actions": actions or [{"id": "CALL-001", "action": "approve", "revision": 1}]}

    def action(self, action, **extra):
        return self.store.review(self.payload([{"id": "CALL-001", "action": action, "revision": 1, **extra}]))

    def assert_api_error(self, status, callable, *args):
        with self.assertRaises(APIError) as caught:
            callable(*args)
        self.assertEqual(caught.exception.status, status)
        return caught.exception

class StoreTests(ReviewFixture):
    def test_approval_restart_and_append_only_history(self):
        result = self.action("approve")
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["items"]["CALL-001"]["status"], "approved")
        self.store = ReviewStore(self.database, self.manifest_path)
        self.assertEqual(result, self.state())
        with sqlite3.connect(self.database) as connection:
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM events")

    def test_comment_invalidates_approval_preserves_text_and_history(self):
        self.action("approve")
        result = self.action("comment", comment="Please include the Marathi explanation.")
        item = result["items"]["CALL-001"]
        self.assertEqual(item["status"], "changes_requested")
        self.assert_api_error(400, self.action, "approve")
        self.assertEqual(item["comments"][0]["text"], "Please include the Marathi explanation.")
        self.assertEqual([event["action"] for event in item["history"]], ["approve", "comment"])

    def test_changes_need_resolution_even_after_reopen_or_comment(self):
        self.action("request_changes", comment="Please recheck the comparison data.")
        self.action("reopen")
        self.action("comment", comment="The data is being checked.")
        self.assert_api_error(400, self.action, "approve")
        result = self.action("approve", resolution="I checked the corrected dataset and confirm the result.")
        item = result["items"]["CALL-001"]
        self.assertEqual(item["status"], "approved")
        self.assertFalse(item["resolution_required"])
        self.assertEqual([event["action"] for event in item["history"]][-2:], ["resolution", "approve"])
        self.assertEqual(len(item["comments"]), 3)

    def test_reopen_revokes_approval(self):
        self.action("approve")
        result = self.action("reopen", comment="I want to check this again.")
        self.assertEqual(result["items"]["CALL-001"]["status"], "pending")
        self.assertEqual(result["items"]["CALL-001"]["comments"][0]["text"], "I want to check this again.")

    def test_clarification_single_requires_resolution_and_bulk_excludes(self):
        approve = {"id": "CALL-002", "revision": 1, "action": "approve"}
        self.assert_api_error(400, self.store.review, self.payload([approve]))
        approve["resolution"] = "Use the customer-provided dataset dated today."
        self.assert_api_error(400, self.store.review, self.payload([
            {"id": "CALL-001", "revision": 1, "action": "approve"}, approve]))
        self.assertEqual(self.state()["version"], 0)
        result = self.store.review(self.payload([approve]))
        self.assertEqual(result["items"]["CALL-002"]["status"], "approved")

    def test_exact_retry_idempotent_and_different_payload_conflicts(self):
        request = self.payload()
        original = self.store.review(request)
        self.assertEqual(self.store.review(request), original)
        request["actions"][0]["action"] = "reopen"
        self.assert_api_error(409, self.store.review, request)
        self.assertEqual(self.state()["version"], 1)
        self.assertEqual(len(self.state()["items"]["CALL-001"]["history"]), 1)

    def test_retry_after_new_comment_returns_current_not_old_approval(self):
        request = self.payload()
        self.store.review(request)
        current = self.action("comment", comment="Please reconsider.")
        self.assertEqual(self.store.review(request), current)
        self.assertEqual(current["items"]["CALL-001"]["status"], "changes_requested")

    def test_concurrent_expected_version_allows_only_one_writer(self):
        first, second = self.payload(), self.payload()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.store.review, payload) for payload in (first, second)]
            outcomes = []
            for future in futures:
                try:
                    outcomes.append(future.result()["version"])
                except APIError as error:
                    outcomes.append(error.status)
        self.assertCountEqual(outcomes, [1, 409])
        self.assertEqual(self.state()["version"], 1)

    def test_changed_item_content_without_version_bump_revokes_approval(self):
        request = self.payload()
        previous = self.store.review(request)
        self.manifest["requirements"][0]["requested_outcome"] = "B"
        self.save_manifest()
        result = self.state()
        self.assertEqual(result["version"], 2)
        item = result["items"]["CALL-001"]
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["revision"], 1)
        self.assertNotEqual(item["fingerprint"], previous["items"]["CALL-001"]["fingerprint"])
        self.assertNotEqual(item["history"][0]["fingerprint"], item["history"][1]["fingerprint"])
        self.assert_api_error(409, self.store.review, request)

    def test_document_revision_change_preserves_identical_item_and_rejects_stale_submit(self):
        self.action("approve")
        request = self.payload()
        self.manifest["document_revision"] = 2
        self.save_manifest()
        self.assert_api_error(409, self.store.review, request)
        self.assertEqual(self.state()["document_revision"], 2)
        self.assertEqual(self.state()["items"]["CALL-001"]["status"], "approved")
        self.assertEqual(self.state()["version"], 2)

    def test_item_revision_must_match_and_other_approvals_are_retained(self):
        self.action("approve")
        self.manifest["document_revision"] = 2
        self.manifest["requirements"][1]["revision"] = 2
        self.save_manifest()
        result = self.state()
        self.assertEqual(result["items"]["CALL-001"]["status"], "approved")
        request = self.payload([{"id": "CALL-002", "action": "approve", "revision": 1, "resolution": "Confirmed."}])
        self.assert_api_error(409, self.store.review, request)

    def test_old_wording_fingerprint_rejected_even_with_fresh_state_version(self):
        old_fingerprint = self.state()["items"]["CALL-001"]["fingerprint"]
        self.manifest["requirements"][0]["requested_outcome"] = "Changed wording"
        self.save_manifest()
        request = self.payload([{"id": "CALL-001", "revision": 1, "action": "approve", "fingerprint": old_fingerprint}])
        self.assert_api_error(409, self.store.review, request)
        request["actions"][0]["fingerprint"] = self.state()["items"]["CALL-001"]["fingerprint"]
        self.assertEqual(self.store.review(request)["items"]["CALL-001"]["status"], "approved")

    def test_manifest_can_grow_while_batch_stays_bounded(self):
        for number in range(3, 31):
            self.manifest["requirements"].append({"id": "CALL-%03d" % number, "revision": 1})
        self.save_manifest()
        self.assertEqual(len(self.state()["items"]), 30)
        actions = [{"id": "CALL-%03d" % number, "revision": 1, "action": "reopen"} for number in range(1, 30)]
        self.assert_api_error(400, self.store.review, self.payload(actions))

    def test_batch_is_atomic_when_last_item_invalid(self):
        request = self.payload([{"id": "CALL-001", "action": "approve", "revision": 1},
                                {"id": "CALL-002", "action": "request_changes", "revision": 1, "comment": ""}])
        self.assert_api_error(400, self.store.review, request)
        result = self.state()
        self.assertEqual(result["version"], 0)
        self.assertEqual(result["items"]["CALL-001"]["history"], [])
        request["actions"][1]["comment"] = "Please provide the dataset."
        result = self.store.review(request)
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["items"]["CALL-001"]["status"], "approved")
        self.assertEqual(result["items"]["CALL-002"]["status"], "changes_requested")

    def test_invalid_manifest_fails_closed(self):
        self.action("approve")
        self.manifest_path.write_text("{", encoding="utf-8")
        self.assert_api_error(503, self.state)
        self.save_manifest()
        self.assertEqual(self.state()["items"]["CALL-001"]["status"], "approved")

    def test_strict_schema_unknown_ids_duplicates_and_comment_bounds(self):
        samples = [
            [{"id": "UNKNOWN", "revision": 1, "action": "approve"}],
            [{"id": "CALL-001", "revision": 1, "action": "approve"}] * 2,
            [{"id": "CALL-001", "revision": 1, "action": "comment", "comment": "a" * 4001}],
            [{"id": "CALL-001", "revision": 1, "action": "approve", "comment": "Do not lose this text."}],
        ]
        for actions in samples:
            with self.subTest(actions=str(actions)[:100]):
                self.assert_api_error(400, self.store.review, self.payload(actions))
        request = self.payload()
        del request["document_revision"]
        self.assert_api_error(400, self.store.review, request)
        self.assertEqual(self.state()["version"], 0)


class HTTPTests(ReviewFixture):
    def setUp(self):
        super().setUp()
        self.token = "test-token-for-hermetic-unit-test-only"
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(
            self.store, hashlib.sha256(self.token.encode()).hexdigest()))
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None, authenticated=True):
        request_headers = {"Origin": PUBLIC_ORIGIN}
        if authenticated:
            request_headers["Authorization"] = "Bearer " + self.token
        if body is not None and not isinstance(body, (str, bytes)):
            body = json.dumps(body)
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def test_http_health_no_state_and_authentication_enforced(self):
        status, headers, body = self.request("GET", "/reviews-api/health", authenticated=False)
        self.assertEqual((status, body), (200, {"ok": True}))
        for suffix in ("", "?token=" + self.token):
            status, _, body = self.request("GET", "/reviews-api/state" + suffix, authenticated=False)
            self.assertEqual(status, 401)
            self.assertNotIn("items", body)
        status, _, _ = self.request("GET", "/reviews-api/state?document_id=test-review", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(status, 401)
        status, headers, body = self.request("GET", "/reviews-api/state?document_id=test-review")
        self.assertEqual(status, 200)
        self.assertEqual(body["version"], 0)
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_http_cors_strict_and_no_unknown_document(self):
        status, headers, _ = self.request("GET", "/reviews-api/state?document_id=test-review", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        status, _, _ = self.request("GET", "/reviews-api/state?document_id=test-review", headers={"Origin": "http://localhost:3000"})
        self.assertEqual(status, 403)
        status, headers, _ = self.request("OPTIONS", "/reviews-api/review", authenticated=False)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], PUBLIC_ORIGIN)
        status, _, _ = self.request("GET", "/reviews-api/state?document_id=other")
        self.assertEqual(status, 404)

    def test_http_post_restart_and_conflict_response(self):
        request = self.payload()
        status, _, result = self.request("POST", "/reviews-api/review", request)
        self.assertEqual(status, 200)
        self.assertEqual(result["items"]["CALL-001"]["status"], "approved")
        request["request_id"] = str(uuid.uuid4())
        status, _, result = self.request("POST", "/reviews-api/review", request)
        self.assertEqual(status, 409)
        self.assertEqual(result["state"]["version"], 1)

    def test_http_body_size_json_and_safe_errors(self):
        status, _, _ = self.request("POST", "/reviews-api/review", "x" * (MAX_BODY + 1), {"Content-Type": "application/json"})
        self.assertEqual(status, 413)
        status, _, body = self.request("POST", "/reviews-api/review", "{bad", {"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertNotIn(self.temp.name, json.dumps(body))
        status, _, _ = self.request("POST", "/reviews-api/review", "{}", {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)


if __name__ == "__main__":
    unittest.main()
