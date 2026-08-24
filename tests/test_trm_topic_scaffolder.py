"""
Unit test suite for TRMTopicScaffolder (topic.pack.v1).
"""

import os
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from trm_topic_scaffolder import TRMTopicScaffolder


class TestTRMTopicScaffolder(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_topics_dir = self.temp_dir.name
        self.scaffolder = TRMTopicScaffolder(self.base_topics_dir)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_scaffold_topic_creates_valid_pack_structure(self):
        topic_slug = "willow-run-tooling-1941"
        topic_title = "Willow Run B-24 Tooling & Progressive Assembly Origins"
        domain = "archival_industrial_history"

        source_files = [
            {
                "sourceId": "src-ford-wr-1941-memoir",
                "filename": "src-ford-wr-1941-memoir.txt",
                "content": "In January 1941, Charles E. Sorensen conceptualized the progressive assembly line layout for B-24 bombers at Willow Run."
            }
        ]

        sample_questions = [
            {
                "sourceId": "src-ford-wr-1941-memoir",
                "question": "What manufacturing philosophy and assembly layout was conceptualized by Charles E. Sorensen in January 1941?",
                "evidenceType": "fact",
                "expectedSpan": {"startByte": 0, "endByte": 120}
            }
        ]

        time_horizon = {"start": "1941-01-01", "end": "1941-12-31"}
        primary_entities = ["Charles E. Sorensen", "Edsel Ford", "Consolidated Aircraft"]

        topic_dir_path = self.scaffolder.scaffold_topic(
            topic_slug=topic_slug,
            topic_title=topic_title,
            domain=domain,
            source_files=source_files,
            sample_questions=sample_questions,
            time_horizon=time_horizon,
            primary_entities=primary_entities
        )

        topic_dir = Path(topic_dir_path)

        # 1. Verify Directory Layout
        self.assertTrue((topic_dir / "topic.manifest.json").exists())
        self.assertTrue((topic_dir / "corpus" / "source_catalog.json").exists())
        self.assertTrue((topic_dir / "corpus" / "src-ford-wr-1941-memoir.txt").exists())
        self.assertTrue((topic_dir / "specs" / "task-willow-run-tooling-1941-001.json").exists())
        self.assertTrue((topic_dir / "config" / "audit_rules.json").exists())
        self.assertTrue((topic_dir / "_kb-sync-staging" / "canonical_knowledge.json").exists())
        self.assertTrue((topic_dir / "_kb-sync-staging" / "staged_review_queue.json").exists())
        self.assertTrue((topic_dir / "_kb-sync-staging" / "pipeline_audit_log.json").exists())
        self.assertTrue((topic_dir / "run_topic_pipeline.py").exists())

        # 2. Verify Manifest Content
        with open(topic_dir / "topic.manifest.json", "r", encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(manifest["topicSlug"], topic_slug)
        self.assertEqual(manifest["topicId"], "TOPIC-WILLOW-RUN-TOOLING-1941")
        self.assertEqual(manifest["sourceCount"], 1)

        # 3. Verify Corpus Hashing
        with open(topic_dir / "corpus" / "source_catalog.json", "r", encoding="utf-8") as f:
            catalog = json.load(f)
        self.assertEqual(len(catalog), 1)
        self.assertTrue(catalog[0]["revision"].startswith("sha256:"))

        # 4. Verify Task Spec
        with open(topic_dir / "specs" / "task-willow-run-tooling-1941-001.json", "r", encoding="utf-8") as f:
            task = json.load(f)
        self.assertEqual(task["taskId"], "TASK-WILLOW-RUN-TOOLING-1941-001")
        self.assertEqual(task["sourceTargets"][0]["sourceRevision"], catalog[0]["revision"])

        # 5. Verify Run Topic Pipeline execution
        result = subprocess.run(
            [sys.executable, str(topic_dir / "run_topic_pipeline.py")],
            capture_output=True,
            text=True,
            check=True
        )
        self.assertIn("Executing topic pipeline for willow-run-tooling-1941", result.stdout)


if __name__ == "__main__":
    unittest.main()
