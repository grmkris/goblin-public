"""Durable reservation accounting. All outbound inference passes through this boundary."""

import json
import os
import time
from pathlib import Path


class BudgetError(RuntimeError):
    pass


class Ledger:
    def __init__(self, path, manifest):
        self.path, self.manifest = Path(path), manifest
        self.rows = []
        if self.path.exists():
            raw = self.path.read_text()
            if raw and not raw.endswith("\n"):
                raise BudgetError("torn ledger")
            self.rows = [json.loads(line) for line in raw.splitlines()]
        self.latest = {row["id"]: row for row in self.rows}

    def totals(self):
        rows = list(self.latest.values())
        return {
            "requests": len(rows),
            "usd": sum(row["chargedUsd"] for row in rows),
            "inputTokens": sum(row.get("chargedInput", 0) for row in rows),
            "outputTokens": sum(row.get("chargedOutput", 0) for row in rows),
        }

    def append(self, row):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as f:
            os.chmod(self.path, 0o600)
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())
        self.rows.append(row)
        self.latest[row["id"]] = row

    def reserve(
        self, operation, input_tokens, output_tokens, input_price, output_price
    ):
        if any(row["state"] == "reserved" for row in self.latest.values()):
            raise BudgetError("unsettled reservation")
        if any(row.get("halt") for row in self.latest.values()):
            raise BudgetError("unknown usage or HTTP outcome; halted")
        if any(row.get("breach") for row in self.latest.values()):
            raise BudgetError("provider exceeded reservation")
        totals = self.totals()
        cost = (input_tokens * input_price + output_tokens * output_price) / 1e6
        if (
            totals["requests"] + 1 > self.manifest["maxRequests"]
            or totals["usd"] + cost + self.manifest["storageReserveUsd"]
            > self.manifest["maxUsd"]
        ):
            raise BudgetError("request or dollar ceiling")
        if (
            totals["inputTokens"] + input_tokens > self.manifest["maxInputTokens"]
            or totals["outputTokens"] + output_tokens > self.manifest["maxOutputTokens"]
        ):
            raise BudgetError("token ceiling")
        row = {
            "id": len(self.latest) + 1,
            "state": "reserved",
            "operation": operation,
            "chargedUsd": cost,
            "chargedInput": input_tokens,
            "chargedOutput": output_tokens,
            "reservedUsd": cost,
            "reservedInput": input_tokens,
            "reservedOutput": output_tokens,
            "inputPrice": input_price,
            "outputPrice": output_price,
            "at": time.time(),
        }
        self.append(row)
        return row

    def settle(
        self, row, usage=None, rejected=False, latency_ms=None, status=200, halt=False
    ):
        result = {
            **row,
            "state": "settled",
            "http": status,
            "latencyMs": latency_ms,
            "usageKnown": usage is not None or rejected,
            "chargedBy": "reservation",
            "halt": halt,
        }
        if rejected:
            result.update(
                chargedUsd=0,
                chargedInput=0,
                chargedOutput=0,
                chargedBy="rejected-before-inference",
            )
        elif usage is not None:
            prompt, completion = usage
            result.update(
                chargedUsd=(
                    prompt * row["inputPrice"] + completion * row["outputPrice"]
                )
                / 1e6,
                chargedInput=prompt,
                chargedOutput=completion,
                chargedBy="reported",
                breach=prompt > row["reservedInput"]
                or completion > row["reservedOutput"],
            )
        self.append(result)
        if result.get("breach"):
            raise BudgetError("provider exceeded reservation")
        return result
