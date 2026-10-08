"""Provider transports with injectable HTTP; never serialize authorization headers."""

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path


class HttpFailure(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"HTTP {status}")


def http(url, payload=None, token=None, method=None, ndjson=False):
    data = (
        None
        if payload is None
        else payload.encode()
        if ndjson
        else json.dumps(payload, ensure_ascii=False).encode()
    )
    headers = {
        "Content-Type": "application/x-ndjson" if ndjson else "application/json",
        "User-Agent": "goblin-retrieval-spike/1",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            content = response.read()
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as error:
        raise HttpFailure(error.code) from None


class Inference:
    def __init__(self, ledger, trace_dir, request=http):
        self.ledger, self.trace_dir, self.request = ledger, Path(trace_dir), request
        self.trace_dir.mkdir(parents=True, exist_ok=True)

    def run(
        self,
        operation,
        url,
        payload,
        key,
        input_price,
        output_price=0,
        max_output=0,
        reported_usage=False,
    ):
        # UTF-8 bytes conservatively bound normal tokenizer input including JSON/roles. Outputs are explicit ceilings.
        tokens = len(json.dumps(payload, ensure_ascii=False).encode()) + 1024
        row = self.ledger.reserve(
            operation, tokens, max_output, input_price, output_price
        )
        start = time.monotonic()
        trace = {"operation": operation, "payload": payload}
        try:
            result = self.request(url, payload, key)
        except HttpFailure as error:
            # Permission/model denials occur before inference; any other failure keeps its reservation charged.
            self.ledger.settle(
                row,
                rejected=error.status in (400, 401, 403, 404),
                latency_ms=(time.monotonic() - start) * 1000,
                status=error.status,
                halt=error.status not in (400, 401, 403, 404),
            )
            raise
        except (OSError, ValueError):
            # Network ambiguity keeps the original unresolved reservation and blocks further admission.
            raise RuntimeError(
                "inference transport failed; reservation retained"
            ) from None
        latency = (time.monotonic() - start) * 1000
        trace.update(response=result, latencyMs=latency)
        path = self.trace_dir / f"{row['id']:05d}.json"
        with open(path, "x") as f:
            os.chmod(path, 0o600)
            json.dump(trace, f, ensure_ascii=False, indent=2)
        usage = result.get("usage")
        observed = None
        if (
            reported_usage
            and usage
            and type(usage.get("prompt_tokens")) is int
            and usage["prompt_tokens"] >= 0
            and type(usage.get("completion_tokens")) is int
            and usage["completion_tokens"] >= 0
        ):
            observed = (usage["prompt_tokens"], usage["completion_tokens"])
        self.ledger.settle(
            row,
            usage=observed,
            latency_ms=latency,
            halt=reported_usage and observed is None,
        )
        if reported_usage and observed is None:
            raise RuntimeError("provider usage missing; charged reservation, halt")
        return result, latency


class Cloudflare:
    def __init__(self, account, token, inference, request=http):
        self.base = "https://api.cloudflare.com/client/v4/accounts/" + account
        self.token, self.inference, self.request = token, inference, request
        self.created = False

    def embed(self, texts):
        result, latency = self.inference.run(
            "bge-m3",
            self.base + "/ai/run/@cf/baai/bge-m3",
            {"contexts": [{"text": text} for text in texts]},
            self.token,
            0.0118,
        )
        return result["result"].get("data", result["result"]), latency

    def create(self, dim):
        self.request(
            self.base + "/vectorize/v2/indexes",
            {
                "name": "goblin-spike-retrieval",
                "config": {"dimensions": dim, "metric": "cosine"},
            },
            self.token,
        )
        self.created = True

    def upsert(self, vectors):
        data = (
            "\n".join(json.dumps(row, separators=(",", ":")) for row in vectors) + "\n"
        )
        return self.request(
            self.base + "/vectorize/v2/indexes/goblin-spike-retrieval/upsert",
            data,
            self.token,
            ndjson=True,
        )

    def query(self, vector):
        start = time.monotonic()
        result = self.request(
            self.base + "/vectorize/v2/indexes/goblin-spike-retrieval/query",
            {
                "vector": vector,
                "topK": 20,
                "namespace": "synthetic-owner-1",
                "returnMetadata": "all",
            },
            self.token,
        )
        return result["result"]["matches"], (time.monotonic() - start) * 1000

    def delete(self):
        if self.created:
            self.request(
                self.base + "/vectorize/v2/indexes/goblin-spike-retrieval",
                None,
                self.token,
                method="DELETE",
            )
            self.created = False

    def clef(self, query, candidates):
        questions = {
            str(row["entryId"]): {
                "type": "noul",
                "instructions": f"Does candidate {row['entryId']} supply evidence answering the query? For current-state queries reject superseded drafts.",
            }
            for row in candidates
        }
        questions["none_relevant"] = {
            "type": "noul",
            "instructions": "Is none of the candidates relevant to answering the query?",
        }
        result, latency = self.inference.run(
            "clef",
            self.base + "/ai/run/@cf/cloudflare/clef",
            {
                "model": "clef",
                "state": {"query": query, "candidates": candidates},
                "questions": questions,
            },
            self.token,
            0.24,
        )
        return result["result"], latency
