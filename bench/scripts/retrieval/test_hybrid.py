"""Pure parts of the Arm B / hybrid / Clef coordinator: fusion, answer validation, scoring and the embedding shape."""

import unittest

from hybrid import aggregate, embed, hybrid_rows, metrics, parse_cheap


class HybridTests(unittest.TestCase):
    def test_reciprocal_rank_fusion_rewards_agreement_and_keeps_twenty(self):
        fts = [{"entryId": i, "score": -10 + i} for i in range(1, 21)]
        vec = [{"entryId": 2, "score": 0.9}] + [{"entryId": 100 + i, "score": 0.5} for i in range(19)]
        fused = hybrid_rows(fts, vec)
        self.assertEqual(fused[0]["entryId"], 2)
        self.assertEqual(len(fused), 20)
        self.assertEqual(len({row["entryId"] for row in fused}), 20)

    def test_cheap_answer_must_cite_offered_ids_consistently(self):
        offered = [{"entryId": 7}, {"entryId": 9}]
        self.assertEqual(parse_cheap('{"ids":[9,7],"none":false}', offered), ([9, 7], True))
        self.assertEqual(parse_cheap('{"ids":[],"none":true}', offered), ([], True))
        for bad in ['{"ids":[8],"none":false}', '{"ids":[7,7],"none":false}', '{"ids":[7],"none":true}', "nope"]:
            self.assertEqual(parse_cheap(bad, offered), ([], False))

    def test_scoring_counts_distinct_targets_rank_and_abstention(self):
        label = {"targets": [{"start": 10, "end": 11}, {"start": 30, "end": 30}]}
        result = metrics(label, [5, 11, 10, 30])
        self.assertEqual(result["recallAt5"], 1.0)
        self.assertEqual(result["mrr"], 0.5)
        self.assertEqual(result["precision"], 0.75)
        self.assertTrue(metrics({"targets": []}, [])["abstained"])
        self.assertEqual(aggregate([metrics({"targets": []}, [1]), result])["absentAbstained"], "0/1")

    def test_embedding_vectors_come_from_response_when_data_is_null(self):
        class Engine:
            def run(self, *_args):
                return {"result": {"data": None, "response": [[0.1, 0.2]], "shape": [1, 2]}}, 5.0

        class Api:
            base, token, inference = "https://example.invalid", "unused", Engine()

        self.assertEqual(embed(Api(), ["x"]), ([[0.1, 0.2]], 5.0))


if __name__ == "__main__":
    unittest.main()
