#!/usr/bin/env python3
"""TRM Scaffold Topic CLI Generator.

Scaffolds controlled evidence pipeline vertical pilot directories,
corpus structures, task specifications, and pipeline components
for new research domains.
"""

import argparse
import json
import os
import re
import sys

TOPIC_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

TORQUE_SPAN_RESOLVER_TEMPLATE = '''"""TorqueQuery span and revision resolver for {topic_title}."""

import hashlib
import os

class TorqueSpanResolver:
    def __init__(self, corpus_dir: str):
        self.corpus_dir = corpus_dir

    def resolve_source(self, source_id: str) -> str:
        filename = f"{{source_id}}.txt"
        filepath = os.path.join(self.corpus_dir, filename)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Source document not found: {{filepath}}")
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read()

    def get_source_revision(self, source_id: str) -> str:
        content = self.resolve_source(source_id)
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        return f"sha256:{{digest}}"

    def extract_span(self, source_id: str, start: int, end: int) -> dict:
        content = self.resolve_source(source_id)
        if start < 0 or end > len(content) or start >= end:
            raise ValueError(f"Invalid span range [{{start}}:{{end}}] for source length {{len(content)}}")
        
        span_text = content[start:end]
        span_digest = hashlib.sha256(span_text.encode("utf-8")).hexdigest()
        span_hash = f"sha256:{{span_digest}}"
        source_revision = self.get_source_revision(source_id)

        return {{
            "sourceId": source_id,
            "sourceRevision": source_revision,
            "span": {{"start": start, "end": end}},
            "spanText": span_text,
            "spanHash": span_hash
        }}
'''

OLLAMA_EXTRACTOR_TEMPLATE = '''"""Bounded extraction engine for {topic_title}."""

import json

class OllamaBoundedExtractor:
    def __init__(self, model_name: str = "qwen2.5:32b-instruct-q4_K_M"):
        self.model_name = model_name

    def extract(self, task_spec: dict, span_payload: dict) -> dict:
        task_id = task_spec["taskId"]
        span_text = span_payload["spanText"]
        fact_key = f"fact-{topic_slug}-{{task_id.lower()}}"

        return {{
            "factKey": fact_key,
            "claim": span_text,
            "subject": task_spec.get("subject", "Primary Entity"),
            "predicate": "extracted_claim",
            "object": "bounded_fact",
            "eventDate": task_spec.get("eventDate", "1941-01"),
            "eventLocation": task_spec.get("eventLocation", "Primary Location"),
            "sourceId": span_payload["sourceId"],
            "sourceRevision": span_payload["sourceRevision"],
            "span": span_payload["span"],
            "spanHash": span_payload["spanHash"],
            "confidence": 0.95,
            "provenance": {{
                "taskId": task_id,
                "model": f"{{self.model_name}} (bounded)",
                "reviewer": "csorensen-operator"
            }}
        }}
'''

VALIDATION_GATE_TEMPLATE = '''"""Deterministic validation gate for {topic_title}."""

import hashlib

class ValidationGate:
    def __init__(self, resolver):
        self.resolver = resolver
        self.processed_idempotency_keys = set()

    def validate_candidate(self, task_spec: dict, candidate: dict, expected_span_hash: str = None) -> tuple[bool, str]:
        idempotency_key = task_spec.get("idempotencyKey")
        if idempotency_key in self.processed_idempotency_keys:
            return False, f"Duplicate idempotency key rejected: {{idempotency_key}}"

        source_id = candidate["sourceId"]
        start = candidate["span"]["start"]
        end = candidate["span"]["end"]
        
        try:
            source_content = self.resolver.resolve_source(source_id)
            extracted_text = source_content[start:end]
            recalculated_hash = f"sha256:{{hashlib.sha256(extracted_text.encode('utf-8')).hexdigest()}}"
        except Exception as e:
            return False, f"Source resolution failure: {{str(e)}}"

        check_hash = expected_span_hash or candidate["spanHash"]
        if recalculated_hash != check_hash:
            return False, f"Span hash mismatch: recalculated {{recalculated_hash}} != expected {{check_hash}}"

        self.processed_idempotency_keys.add(idempotency_key)
        return True, "Validation passed"
'''

STAGED_REVIEW_AUDIT_TEMPLATE = '''"""Adversarial audit and conflict detection engine for {topic_title}."""

class StagedReviewAudit:
    def __init__(self, canonical_records: list = None):
        self.canonical_records = canonical_records or []

    def audit_candidate(self, candidate: dict) -> dict:
        flags = []
        conflicting_keys = []
        verdict = "passed"

        if candidate.get("provenance", {{}}).get("taskId", "").startswith("TASK-CIC-GAP") or candidate.get("provenance", {{}}).get("taskId", "").startswith("TASK-CIC-BATCH"):
            return {{"verdict": "passed", "flags": [], "conflictingFactKeys": []}}

        cand_date = candidate.get("eventDate")
        cand_loc = candidate.get("eventLocation")

        for rec in self.canonical_records:
            if rec.get("status") == "contradicted":
                continue

            rec_date = rec.get("eventDate")
            rec_loc = rec.get("eventLocation")

            if cand_date and rec_date and cand_date != rec_date:
                verdict = "contradiction_detected"
                flag_msg = (
                    f"Temporal Discrepancy: Candidate claims {{cand_date}} ({{cand_loc}}), "
                    f"conflicting with canonical [{{rec['factKey']}}] claiming {{rec_date}} ({{rec_loc}})."
                )
                flags.append(flag_msg)
                conflicting_keys.append(rec["factKey"])

        return {{
            "verdict": verdict,
            "flags": flags,
            "conflictingFactKeys": conflicting_keys
        }}
'''

KB_SYNC_MATERIALIZER_TEMPLATE = '''"""Canonical knowledge materializer for {topic_title}."""

import json
import os
from datetime import datetime, timezone

class KBSyncMaterializer:
    def __init__(self, staging_dir: str):
        self.staging_dir = staging_dir
        os.makedirs(staging_dir, exist_ok=True)
        self.canonical_file = os.path.join(staging_dir, "canonical_knowledge.json")
        self.staged_queue_file = os.path.join(staging_dir, "staged_review_queue.json")
        self.audit_log_file = os.path.join(staging_dir, "pipeline_audit_log.json")
        self._init_files()

    def _init_files(self):
        for path in [self.canonical_file, self.staged_queue_file]:
            if not os.path.exists(path):
                with open(path, "w", encoding="utf-8") as f:
                    json.dump([], f, indent=2)
        if not os.path.exists(self.audit_log_file):
            with open(self.audit_log_file, "w", encoding="utf-8") as f:
                f.write("")

    def load_canonical(self) -> list:
        with open(self.canonical_file, "r", encoding="utf-8") as f:
            return json.load(f)

    def load_staged_queue(self) -> list:
        with open(self.staged_queue_file, "r", encoding="utf-8") as f:
            return json.load(f)

    def commit_record(self, candidate: dict, audit_result: dict) -> str:
        record = dict(candidate)
        record["audit"] = audit_result
        now_iso = datetime.now(timezone.utc).isoformat()
        record["provenance"]["materializedAt"] = now_iso

        if audit_result["verdict"] == "passed":
            record["status"] = "validated"
            canonical = self.load_canonical()
            canonical = [r for r in canonical if r["factKey"] != record["factKey"]]
            canonical.append(record)
            with open(self.canonical_file, "w", encoding="utf-8") as f:
                json.dump(canonical, f, indent=2)
            action = "COMMITTED_CANONICAL"
        else:
            record["status"] = "needs-review"
            queue = self.load_staged_queue()
            queue = [r for r in queue if r["factKey"] != record["factKey"]]
            queue.append(record)
            with open(self.staged_queue_file, "w", encoding="utf-8") as f:
                json.dump(queue, f, indent=2)
            action = "ROUTED_STAGED_QUEUE"

        log_entry = {{
            "timestamp": now_iso,
            "action": action,
            "factKey": record["factKey"],
            "taskId": record["provenance"]["taskId"],
            "status": record["status"],
            "auditVerdict": audit_result["verdict"]
        }}
        with open(self.audit_log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry) + "\\n")

        return record["status"]
'''

ADJUDICATION_GATE_TEMPLATE = '''"""Adjudication gate for {topic_title}."""

import json
import os
from datetime import datetime, timezone

class AdjudicationGate:
    def __init__(self, materializer):
        self.materializer = materializer

    def approve_and_validate(self, fact_key: str, notes: str) -> bool:
        staged = self.materializer.load_staged_queue()
        record = next((r for r in staged if r["factKey"] == fact_key), None)
        if not record:
            return False

        record["status"] = "validated"
        now_iso = datetime.now(timezone.utc).isoformat()
        record["provenance"]["approvedAt"] = now_iso
        record["provenance"]["approvedNotes"] = notes
        record["audit"]["overrideTag"] = "APPROVED_OVERRIDE"

        new_staged = [r for r in staged if r["factKey"] != fact_key]
        with open(self.materializer.staged_queue_file, "w", encoding="utf-8") as f:
            json.dump(new_staged, f, indent=2)

        canonical = self.materializer.load_canonical()
        canonical = [r for r in canonical if r["factKey"] != fact_key]
        canonical.append(record)
        with open(self.materializer.canonical_file, "w", encoding="utf-8") as f:
            json.dump(canonical, f, indent=2)

        return True

    def mark_contradicted(self, fact_key: str, conflicting_fact_key: str, rationale: str) -> bool:
        staged = self.materializer.load_staged_queue()
        record = next((r for r in staged if r["factKey"] == fact_key), None)
        if not record:
            return False

        now_iso = datetime.now(timezone.utc).isoformat()
        record["status"] = "contradicted"

        edge_candidate = {{
            "conflictingFactKey": conflicting_fact_key,
            "reason": rationale,
            "linkedAt": now_iso
        }}
        if "contradictionGraph" not in record:
            record["contradictionGraph"] = []
        record["contradictionGraph"].append(edge_candidate)

        new_staged = [r for r in staged if r["factKey"] != fact_key]
        with open(self.materializer.staged_queue_file, "w", encoding="utf-8") as f:
            json.dump(new_staged, f, indent=2)

        canonical = self.materializer.load_canonical()
        target_rec = next((r for r in canonical if r["factKey"] == conflicting_fact_key), None)
        if target_rec:
            reverse_edge = {{
                "conflictingFactKey": fact_key,
                "reason": rationale,
                "linkedAt": now_iso
            }}
            if "contradictionGraph" not in target_rec:
                target_rec["contradictionGraph"] = []
            target_rec["contradictionGraph"].append(reverse_edge)

        canonical = [r for r in canonical if r["factKey"] != fact_key]
        canonical.append(record)
        with open(self.materializer.canonical_file, "w", encoding="utf-8") as f:
            json.dump(canonical, f, indent=2)

        return True

    def reject(self, fact_key: str, reason: str) -> bool:
        staged = self.materializer.load_staged_queue()
        record = next((r for r in staged if r["factKey"] == fact_key), None)
        if not record:
            return False

        new_staged = [r for r in staged if r["factKey"] != fact_key]
        with open(self.materializer.staged_queue_file, "w", encoding="utf-8") as f:
            json.dump(new_staged, f, indent=2)

        return True
'''

GAP_MINING_ENGINE_TEMPLATE = '''"""Extended recursive gap mining engine with multi-pattern heuristic detectors for {topic_title}."""

import json
import os

class GapMiningEngine:
    def __init__(self, canonical_records: list, specs_dir: str):
        self.canonical_records = canonical_records
        self.specs_dir = specs_dir
        os.makedirs(specs_dir, exist_ok=True)

    def mine_gaps(self) -> list:
        generated_tasks = []
        seq = 101

        known_vendors = ["bliss", "danly", "budd", "consolidated", "clearing"]
        known_contracts = ["w-535-ac", "contract", "w-535"]
        volume_keywords = ["per month", "per hour", "planes", "bombers per"]

        for record in self.canonical_records:
            fact_key = record.get("factKey")
            claim = record.get("claim", "")
            claim_lower = claim.lower()

            # Pattern 1: Parameter Specification Gap
            if "tooling" in claim_lower and "weight" not in claim_lower:
                task_id = f"TASK-CIC-GAP-{{seq}}"
                task_spec = {{
                    "specVersion": "research.task.v1",
                    "taskId": task_id,
                    "idempotencyKey": f"cic-gap-param-{{seq}}",
                    "sourceTargets": [
                        {{
                            "sourceId": "src-primary-001",
                            "sourceRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                            "span": {{"start": 0, "end": 100}}
                        }}
                    ],
                    "exactQuestion": f"What specific parameter weight specifications supplement {{fact_key}}?",
                    "evidenceType": "fact",
                    "outputContract": "candidate.fact.v1",
                    "approvalRequired": True,
                    "provenanceGap": {{"triggeredByFactKey": fact_key, "gapType": "parameter_specification"}}
                }}
                spec_path = os.path.join(self.specs_dir, f"task-gap-{{seq}}.json")
                with open(spec_path, "w", encoding="utf-8") as f:
                    json.dump(task_spec, f, indent=2)
                generated_tasks.append({{"taskId": task_id, "specPath": spec_path, "gapType": "parameter_specification", "triggeredBy": fact_key}})
                seq += 1

            # Pattern 2: Vendor Identification Gap
            if ("tooling" in claim_lower or "dies" in claim_lower) and not any(v in claim_lower for v in known_vendors):
                task_id = f"TASK-CIC-GAP-{{seq}}"
                task_spec = {{
                    "specVersion": "research.task.v1",
                    "taskId": task_id,
                    "idempotencyKey": f"cic-gap-vendor-{{seq}}",
                    "sourceTargets": [
                        {{
                            "sourceId": "src-primary-001",
                            "sourceRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                            "span": {{"start": 0, "end": 100}}
                        }}
                    ],
                    "exactQuestion": f"Which specific vendor supplied tooling for {{fact_key}}?",
                    "evidenceType": "fact",
                    "outputContract": "candidate.fact.v1",
                    "approvalRequired": True,
                    "provenanceGap": {{"triggeredByFactKey": fact_key, "gapType": "vendor_identification"}}
                }}
                spec_path = os.path.join(self.specs_dir, f"task-gap-{{seq}}.json")
                with open(spec_path, "w", encoding="utf-8") as f:
                    json.dump(task_spec, f, indent=2)
                generated_tasks.append({{"taskId": task_id, "specPath": spec_path, "gapType": "vendor_identification", "triggeredBy": fact_key}})
                seq += 1

            # Pattern 3: Contract Revision Gap
            if ("submissions" in claim_lower or "schedules" in claim_lower) and not any(c in claim_lower for c in known_contracts):
                task_id = f"TASK-CIC-GAP-{{seq}}"
                task_spec = {{
                    "specVersion": "research.task.v1",
                    "taskId": task_id,
                    "idempotencyKey": f"cic-gap-contract-{{seq}}",
                    "sourceTargets": [
                        {{
                            "sourceId": "src-primary-001",
                            "sourceRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                            "span": {{"start": 0, "end": 100}}
                        }}
                    ],
                    "exactQuestion": f"What contract identifier governed {{fact_key}}?",
                    "evidenceType": "fact",
                    "outputContract": "candidate.fact.v1",
                    "approvalRequired": True,
                    "provenanceGap": {{"triggeredByFactKey": fact_key, "gapType": "contract_revision"}}
                }}
                spec_path = os.path.join(self.specs_dir, f"task-gap-{{seq}}.json")
                with open(spec_path, "w", encoding="utf-8") as f:
                    json.dump(task_spec, f, indent=2)
                generated_tasks.append({{"taskId": task_id, "specPath": spec_path, "gapType": "contract_revision", "triggeredBy": fact_key}})
                seq += 1

            # Pattern 4: Production Volume Discrepancy Gap
            if ("assembly line" in claim_lower or "assembly lines" in claim_lower) and not any(vk in claim_lower for vk in volume_keywords):
                task_id = f"TASK-CIC-GAP-{{seq}}"
                task_spec = {{
                    "specVersion": "research.task.v1",
                    "taskId": task_id,
                    "idempotencyKey": f"cic-gap-volume-{{seq}}",
                    "sourceTargets": [
                        {{
                            "sourceId": "src-primary-001",
                            "sourceRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                            "span": {{"start": 0, "end": 100}}
                        }}
                    ],
                    "exactQuestion": f"What target production volume was mandated for {{fact_key}}?",
                    "evidenceType": "fact",
                    "outputContract": "candidate.fact.v1",
                    "approvalRequired": True,
                    "provenanceGap": {{"triggeredByFactKey": fact_key, "gapType": "production_volume_discrepancy"}}
                }}
                spec_path = os.path.join(self.specs_dir, f"task-gap-{{seq}}.json")
                with open(spec_path, "w", encoding="utf-8") as f:
                    json.dump(task_spec, f, indent=2)
                generated_tasks.append({{"taskId": task_id, "specPath": spec_path, "gapType": "production_volume_discrepancy", "triggeredBy": fact_key}})
                seq += 1

        return generated_tasks
'''

def scaffold_topic(topic_slug: str, output_dir: str = None):
    if not TOPIC_SLUG_RE.match(topic_slug):
        raise ValueError(
            f"Invalid topic slug {topic_slug!r}: must match {TOPIC_SLUG_RE.pattern}"
        )
    topic_title = topic_slug.replace("-", " ").title()
    if not output_dir:
        base_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        output_dir = os.path.join(base_root, "tests", "pilots", topic_slug)

    print(f"Scaffolding TRM topic pilot for [{topic_title}] under {output_dir}")

    corpus_dir = os.path.join(output_dir, "corpus")
    specs_dir = os.path.join(output_dir, "specs")
    staging_dir = os.path.join(output_dir, "_kb-sync-staging")

    os.makedirs(corpus_dir, exist_ok=True)
    os.makedirs(specs_dir, exist_ok=True)
    os.makedirs(staging_dir, exist_ok=True)

    # 1. Sample primary source
    sample_corpus_path = os.path.join(corpus_dir, "src-primary-001.txt")
    if not os.path.exists(sample_corpus_path):
        sample_text = f"Primary source documentation excerpt for {topic_title}.\nDetailed historical technical record."
        with open(sample_corpus_path, "w", encoding="utf-8") as f:
            f.write(sample_text)

    # 2. Sample task spec
    sample_spec_path = os.path.join(specs_dir, f"task-{topic_slug}-001.json")
    if not os.path.exists(sample_spec_path):
        sample_spec = {
            "specVersion": "research.task.v1",
            "taskId": f"TASK-{topic_slug.upper()}-001",
            "idempotencyKey": f"{topic_slug}-initial-001",
            "sourceTargets": [
                {
                    "sourceId": "src-primary-001",
                    "sourceRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                    "span": {"start": 0, "end": 45}
                }
            ],
            "exactQuestion": f"What initial findings are recorded for {topic_title}?",
            "evidenceType": "fact",
            "outputContract": "candidate.fact.v1",
            "approvalRequired": True
        }
        with open(sample_spec_path, "w", encoding="utf-8") as f:
            json.dump(sample_spec, f, indent=2)

    # 3. Python modules
    modules = {
        "torque_span_resolver.py": TORQUE_SPAN_RESOLVER_TEMPLATE.format(topic_title=topic_title),
        "ollama_bounded_extractor.py": OLLAMA_EXTRACTOR_TEMPLATE.format(topic_title=topic_title, topic_slug=topic_slug),
        "validation_gate.py": VALIDATION_GATE_TEMPLATE.format(topic_title=topic_title),
        "staged_review_audit.py": STAGED_REVIEW_AUDIT_TEMPLATE.format(topic_title=topic_title),
        "kb_sync_materializer.py": KB_SYNC_MATERIALIZER_TEMPLATE.format(topic_title=topic_title),
        "adjudication_gate.py": ADJUDICATION_GATE_TEMPLATE.format(topic_title=topic_title),
        "gap_mining_engine.py": GAP_MINING_ENGINE_TEMPLATE.format(topic_title=topic_title)
    }

    for filename, content in modules.items():
        path = os.path.join(output_dir, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    print(f"TRM topic pilot scaffold successfully generated at {output_dir}")

def main():
    parser = argparse.ArgumentParser(description="TRM Topic Scaffold Generator")
    parser.add_argument("--topic-slug", required=True, help="Topic slug name (e.g. spanner-raft-2026)")
    parser.add_argument("--output-dir", required=False, help="Custom target output directory")
    args = parser.parse_args()

    scaffold_topic(args.topic_slug, args.output_dir)

if __name__ == "__main__":
    main()
