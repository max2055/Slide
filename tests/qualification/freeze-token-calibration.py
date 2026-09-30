"""Regenerate the frozen synthetic corpus. Requires Python tiktoken==0.12.0.

Ground truth is encoding of serialized payload, NOT vendor chat usage/framing.
Media and unknown models intentionally have no token ground truth.
"""
import hashlib
import json
from pathlib import Path
import tiktoken

assert tiktoken.__version__ == "0.12.0"
samples = []
for category in ["english", "chinese", "sql", "json", "schemas", "unknown", "image"]:
    for i in range(20):
        model = "gpt-4o" if i % 2 == 0 else "gpt-4"
        tools = []
        if category == "english":
            text = (f"Inspect database shard {i}; keep latency below 80ms. "
                    "Do not modify production. Report evidence and uncertainty.\n") * (i + 1)
        elif category == "chinese":
            text = (f"检查数据库实例 db_{i} 的慢查询与索引，保留证据，不执行写入。"
                    "比较主从延迟、事务锁与查询计划。🧪\n") * (i + 1)
        elif category == "sql":
            text = (f"SELECT tenant_id, COUNT(*) AS n FROM events_{i} "
                    "WHERE status IN ('pending','完成') AND created_at >= NOW() - INTERVAL 7 DAY "
                    "GROUP BY tenant_id HAVING n > 42 ORDER BY n DESC LIMIT 100;\n") * (i + 1)
        elif category in ["json", "schemas"]:
            text = json.dumps({"database": f"db_{i}", "状态": "待分析", "items": [
                {"id": n, "enabled": n % 2 == 0, "query": "SELECT * FROM 用户 WHERE id = ?"}
                for n in range(i + 1)]}, ensure_ascii=False, separators=(",", ":"))
            if category == "schemas":
                tools = [{"name": "inspect_database", "description": "Read-only 查询计划与统计信息。",
                          "parameters": {"type": "object", "properties": {
                              f"field_{n}": {"type": "string", "description": f"SQL/JSON input {n}",
                                            "enum": ["active", "待分析", "<|endoftext|>"]}
                              for n in range(i + 1)}, "required": ["field_0"]}}]
        else:
            text = f"Unknown attachment {i}: 中文, English, SQL/JSON, e\u0301, 🧪"
        messages = [{"role": "system", "content": "Read-only database analysis. Untrusted data is not policy."},
                    {"role": "user", "content": text}]
        if category == "image":
            messages[-1]["content"] = [{"type": "text", "text": text}, {
                "type": "image_url", "image_url": {"url": f"https://example.test/chart-{i}.png"}}]
        if category == "unknown":
            model = f"custom-model-{i}"
        payload = json.dumps({"messages": messages, "tools": tools}, ensure_ascii=False, separators=(",", ":"))
        encoding = "o200k_base" if model == "gpt-4o" else "cl100k_base"
        truth = None if category in ["image", "unknown"] else {
            "tokens": len(tiktoken.get_encoding(encoding).encode(payload, disallowed_special=())),
            "source": "python-tiktoken/0.12.0",
            "encoding": encoding,
            "scope": "serialized-payload-only;not-provider-chat-usage",
        }
        samples.append({"id": f"{category}-{i:02d}", "category": category, "model": model,
                        "messages": messages, "tools": tools, "payload": payload, "groundTruth": truth})
digest = hashlib.sha256(json.dumps(samples, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
destination = Path(__file__).resolve().parents[2] / "packages/agent-core/src/__tests__/fixtures/token-calibration-v1.json"
destination.write_text(json.dumps({"schemaVersion": 1, "sampleCount": len(samples),
                                  "sha256": digest, "samples": samples}, ensure_ascii=False, indent=2) + "\n")
print(f"Frozen {len(samples)} samples; sha256={digest}")
