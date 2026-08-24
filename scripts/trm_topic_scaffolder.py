"""
trm_topic_scaffolder.py
Automated generator for TRM Topic Packs (topic.pack.v1) and controlled evidence harnesses.
"""

import os
import json
import hashlib
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional


def write_json_atomic(target_path: Path, data: Any) -> None:
    """Write JSON data atomically using a temporary file."""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target_path.parent, delete=False) as tmp:
        json.dump(data, tmp, indent=2)
        tmp_name = tmp.name
    Path(tmp_name).replace(target_path)


class TRMTopicScaffolder:
    def __init__(self, base_topics_dir: str):
        self.base_topics_dir = Path(base_topics_dir)

    def scaffold_topic(
        self,
        topic_slug: str,
        topic_title: str,
        domain: str,
        source_files: List[Dict[str, str]],
        sample_questions: List[Dict[str, Any]],
        time_horizon: Optional[Dict[str, str]] = None,
        primary_entities: Optional[List[str]] = None,
        audit_rules: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Scaffolds a complete topic.pack.v1 directory layout.
        
        :param topic_slug: Unique identifier slug for the topic (e.g. willow-run-tooling-1941)
        :param topic_title: Human-readable topic title
        :param domain: Research domain tag
        :param source_files: List of dicts with {"sourceId": ..., "filename": ..., "content": ...}
        :param sample_questions: List of task question definitions
        :param time_horizon: Dict with {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
        :param primary_entities: List of primary entity names
        :param audit_rules: Optional custom audit rules object
        :return: Absolute path to the scaffolded topic directory
        """
        topic_dir = self.base_topics_dir / topic_slug
        corpus_dir = topic_dir / "corpus"
        specs_dir = topic_dir / "specs"
        config_dir = topic_dir / "config"
        staging_dir = topic_dir / "_kb-sync-staging"

        for d in [corpus_dir, specs_dir, config_dir, staging_dir]:
            d.mkdir(parents=True, exist_ok=True)

        # 1. Ingest & Hash Corpus
        source_catalog = []
        for src in source_files:
            content = src["content"]
            content_bytes = content.encode("utf-8")
            digest = f"sha256:{hashlib.sha256(content_bytes).hexdigest()}"
            filename = src.get("filename", f"{src['sourceId']}.txt")
            file_path = corpus_dir / filename
            
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(content)

            source_catalog.append({
                "sourceId": src["sourceId"],
                "filename": filename,
                "revision": digest,
                "byteLength": len(content_bytes)
            })

        write_json_atomic(corpus_dir / "source_catalog.json", source_catalog)

        # 2. Topic Manifest
        topic_id = f"TOPIC-{topic_slug.upper()}"
        horizon = time_horizon or {"start": "1940-01-01", "end": "1949-12-31"}
        entities = primary_entities or []

        manifest = {
            "$schema": "https://specs.pipeline.local/schemas/topic.manifest.v1.json",
            "topicId": topic_id,
            "topicSlug": topic_slug,
            "domain": domain,
            "title": topic_title,
            "timeHorizon": horizon,
            "primaryEntities": entities,
            "status": "scaffolded",
            "sourceCount": len(source_files),
            "createdAt": datetime.now(timezone.utc).isoformat()
        }
        write_json_atomic(topic_dir / "topic.manifest.json", manifest)

        # 3. Generate Task Specifications (research.task.v1)
        for i, q in enumerate(sample_questions, 1):
            task_id = f"TASK-{topic_slug.upper()}-{i:03d}"
            
            matching_source = next(
                (s for s in source_catalog if s["sourceId"] == q["sourceId"]),
                None
            )
            source_revision = matching_source["revision"] if matching_source else "sha256:unknown"

            task_payload = {
                "$schema": "https://specs.pipeline.local/schemas/research.task.v1.json",
                "taskId": task_id,
                "topicId": topic_id,
                "topicSlug": topic_slug,
                "idempotencyKey": f"{topic_slug}-{i:03d}",
                "evidenceType": q.get("evidenceType", "fact"),
                "sourceTargets": [
                    {
                        "sourceId": q["sourceId"],
                        "sourceRevision": source_revision,
                        "expectedSpan": q.get("expectedSpan", {"startByte": 0, "endByte": len(q.get("content", ""))})
                    }
                ],
                "exactQuestion": q["question"],
                "outputContract": q.get("outputContract", "candidate.fact.v1"),
                "approvalRequired": q.get("approvalRequired", True)
            }
            write_json_atomic(specs_dir / f"task-{topic_slug}-{i:03d}.json", task_payload)

        # 4. Config & Audit Rules
        default_audit = {
            "topicId": topic_id,
            "temporalSanity": {
                "validRange": [horizon["start"], horizon["end"]],
                "flagCrossDateConflicts": True
            },
            "overClaimTriggers": [],
            "entityResolution": {entity: [entity] for entity in entities}
        }
        effective_audit = audit_rules or default_audit
        write_json_atomic(config_dir / "audit_rules.json", effective_audit)

        # 5. Initialize Staging Queues
        for fname in ["canonical_knowledge.json", "staged_review_queue.json", "pipeline_audit_log.json"]:
            write_json_atomic(staging_dir / fname, [])

        # 6. Generate Deterministic Orchestrator script
        orchestrator_code = f'''"""
Deterministic orchestrator for topic {topic_slug}.
Auto-generated by TRMTopicScaffolder.
"""

import json
from pathlib import Path

def run_pipeline():
    base_dir = Path(__file__).parent
    manifest_path = base_dir / "topic.manifest.json"
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    print(f"[TRM] Executing topic pipeline for {{manifest['topicSlug']}} ({{manifest['topicId']}})")
    specs = sorted((base_dir / "specs").glob("task-*.json"))
    print(f"[TRM] Loaded {{len(specs)}} tasks from specs/")
    
    for spec_path in specs:
        with open(spec_path, "r", encoding="utf-8") as f:
            task = json.load(f)
        print(f"  -> Ready task {{task['taskId']}}: {{task['exactQuestion']}}")

if __name__ == "__main__":
    run_pipeline()
'''
        with open(topic_dir / "run_topic_pipeline.py", "w", encoding="utf-8") as f:
            f.write(orchestrator_code)

        return str(topic_dir.resolve())


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Scaffold a TRM Topic Pack (topic.pack.v1)")
    parser.add_argument("--topics-dir", default="./topics", help="Base directory for topics")
    parser.add_argument("--slug", required=True, help="Topic slug (e.g. willow-run-tooling-1941)")
    parser.add_argument("--title", required=True, help="Topic title")
    parser.add_argument("--domain", default="general_archival", help="Domain category")
    
    args = parser.parse_args()
    scaffolder = TRMTopicScaffolder(args.topics_dir)
    created_path = scaffolder.scaffold_topic(
        topic_slug=args.slug,
        topic_title=args.title,
        domain=args.domain,
        source_files=[],
        sample_questions=[]
    )
    print(f"Scaffolded TRM Topic Pack at: {created_path}")
