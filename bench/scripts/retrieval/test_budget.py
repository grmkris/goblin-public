"""Injected HTTP tests prove admission and cleanup accounting without live inference."""

import tempfile
import unittest
from pathlib import Path

from budget import BudgetError, Ledger
from providers import Cloudflare, HttpFailure, Inference


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.manifest = {
            "maxRequests": 3,
            "maxUsd": 0.002,
            "storageReserveUsd": 0,
            "maxInputTokens": 100000,
            "maxOutputTokens": 1000,
        }

    def tearDown(self):
        self.temp.cleanup()

    def ledger(self):
        return Ledger(self.root / "attempts.jsonl", self.manifest)

    def test_unknown_reservation_survives_restart_and_denies_next(self):
        self.ledger().reserve("unknown", 100, 10, 1, 1)
        with self.assertRaisesRegex(BudgetError, "unsettled"):
            self.ledger().reserve("next", 1, 1, 1, 1)

    def test_reported_breach_is_retained_and_latches(self):
        ledger = self.ledger()
        row = ledger.reserve("first", 10, 1, 1, 1)
        with self.assertRaisesRegex(BudgetError, "exceeded"):
            ledger.settle(row, (10, 3))
        self.assertEqual(self.ledger().totals()["outputTokens"], 3)
        with self.assertRaisesRegex(BudgetError, "exceeded"):
            self.ledger().reserve("next", 1, 1, 1, 1)

    def test_dollar_request_and_torn_ledger_limits(self):
        ledger = self.ledger()
        with self.assertRaises(BudgetError):
            ledger.reserve("expensive", 10000, 1, 1, 1)
        for i in range(3):
            ledger.settle(ledger.reserve(str(i), 1, 1, 1, 1), (1, 1))
        with self.assertRaises(BudgetError):
            ledger.reserve("fourth", 1, 1, 1, 1)
        (self.root / "attempts.jsonl").write_text("{")
        with self.assertRaisesRegex(BudgetError, "torn"):
            self.ledger()

    def test_http_denial_charges_attempt_but_no_inference_tokens(self):
        def denied(*args):
            raise HttpFailure(403)

        engine = Inference(self.ledger(), self.root / "trace", denied)
        with self.assertRaises(HttpFailure):
            engine.run("denied", "https://example.invalid", {}, "injected", 1)
        totals = self.ledger().totals()
        self.assertEqual(totals["requests"], 1)
        self.assertEqual(totals["usd"], 0)

    def test_injected_usage_and_trace_never_include_authorization(self):
        def response(*args):
            return {
                "usage": {"prompt_tokens": 100, "completion_tokens": 4},
                "choices": [],
            }

        engine = Inference(self.ledger(), self.root / "trace", response)
        engine.run(
            "known",
            "https://example.invalid",
            {"question": "q"},
            "injected-key-not-a-credential",
            1,
            1,
            10,
            True,
        )
        self.assertEqual(self.ledger().totals()["inputTokens"], 100)
        self.assertNotIn(
            "injected-key-not-a-credential",
            (self.root / "trace/00001.json").read_text(),
        )

    def test_missing_reported_usage_latches_across_restart(self):
        engine = Inference(self.ledger(), self.root / "trace", lambda *args: {})
        with self.assertRaisesRegex(RuntimeError, "usage missing"):
            engine.run(
                "missing", "https://example.invalid", {}, "injected", 1, 1, 10, True
            )
        self.assertGreater(self.ledger().totals()["usd"], 0)
        with self.assertRaisesRegex(BudgetError, "halted"):
            self.ledger().reserve("next", 1, 1, 1, 1)

    def test_cloudflare_clef_has_one_noul_per_candidate_and_none_question(self):
        seen = []

        def response(url, payload, key):
            seen.append(payload)
            return {
                "result": {
                    "answers": {
                        key: {"type": "noul", "noul": 0.9}
                        for key in payload["questions"]
                    }
                }
            }

        api = Cloudflare(
            "injected-account",
            "injected",
            Inference(self.ledger(), self.root / "trace", response),
            response,
        )
        api.clef(
            "query",
            [
                {"entryId": 1, "text": "candidate", "at": 0},
                {"entryId": 2, "text": "other", "at": 1},
            ],
        )
        self.assertEqual(set(seen[0]["questions"]), {"1", "2", "none_relevant"})
        self.assertTrue(all(v["type"] == "noul" for v in seen[0]["questions"].values()))


if __name__ == "__main__":
    unittest.main()
