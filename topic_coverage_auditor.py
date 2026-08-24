#!/usr/bin/env python3
"""TRM Topic Coverage & Completeness Auditor.

Performs a 3-tier coverage audit across research topics:
1. Orphan Source Audit: Checks for unindexed corpus files.
2. Topic Emergence Mining: Discovers unmapped entity clusters for topic scaffolding.
3. Scope Drift Audit: Flags canonical facts falling outside declared topic time horizons.
"""

import argparse
import hashlib
import json
import os
import re
import sys

class TopicCoverageAuditor:
    def __init__(self, topics_dir: str, corpus_dir: str):
        self.topics_dir = os.path.abspath(topics_dir)
        self.corpus_dir = os.path.abspath(corpus_dir) if corpus_dir else None

    def run_audit(self) -> dict:
        orphan_results = self._audit_orphan_sources()
        emergence_results = self._audit_topic_emergence()
        drift_results = self._audit_scope_drift()

        report = {
            "summary": {
                "activeTopicsMonitored": len(self._get_active_topics()),
                "orphanUnindexedSources": len(orphan_results["orphans"]),
                "emergentTopicCandidates": len(emergence_results["candidates"]),
                "scopeDriftDiscrepancies": len(drift_results["driftedRecords"])
            },
            "sourceCoverage": orphan_results,
            "topicEmergence": emergence_results,
            "scopeDrift": drift_results
        }
        return report

    def _get_active_topics(self) -> list:
        topics = []
        if not os.path.exists(self.topics_dir):
            return topics
        for entry in os.listdir(self.topics_dir):
            full_path = os.path.join(self.topics_dir, entry)
            if os.path.isdir(full_path):
                topics.append(entry)
        return topics

    def _audit_orphan_sources(self) -> dict:
        orphans = []
        covered_count = 0

        if self.corpus_dir and os.path.exists(self.corpus_dir):
            for filename in os.listdir(self.corpus_dir):
                if not filename.endswith(".txt"):
                    continue
                filepath = os.path.join(self.corpus_dir, filename)
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
                file_hash = f"sha256:{hashlib.sha256(content.encode('utf-8')).hexdigest()}"

                # Check if task specs reference this file
                is_covered = False
                specs_dir = os.path.abspath(os.path.join(self.corpus_dir, "..", "specs"))
                if os.path.exists(specs_dir):
                    for spec_file in os.listdir(specs_dir):
                        if spec_file.endswith(".json"):
                            with open(os.path.join(specs_dir, spec_file), "r", encoding="utf-8") as sf:
                                spec_data = json.load(sf)
                                for target in spec_data.get("sourceTargets", []):
                                    source_id = target.get("sourceId", "")
                                    if source_id and filename == f"{source_id}.txt":
                                        is_covered = True
                                        break

                if is_covered:
                    covered_count += 1
                else:
                    orphans.append({
                        "filename": filename,
                        "fileHash": file_hash,
                        "actionableRemediation": f"Queue {filename} for batch_task_generator.py"
                    })

        return {
            "status": "PASS" if not orphans else "ACTION_REQUIRED",
            "coveredCount": covered_count,
            "orphans": orphans
        }

    ENTITY_RE = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b")
    YEAR_RE = re.compile(r"\b(1[6-9]\d{2}|20\d{2})\b")
    MIN_ENTITY_DENSITY = 2   # entity phrase must recur at least this many times in the corpus
    MIN_CLUSTER_SIZE = 2     # a candidate needs at least this many distinct unmapped entities

    def _known_entities(self) -> set:
        known = set()
        for topic in self._get_active_topics():
            manifest_path = os.path.join(self.topics_dir, topic, "topic.manifest.json")
            if not os.path.exists(manifest_path):
                continue
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            for entity in manifest.get("primaryEntities", []):
                known.add(entity.strip().lower())
        return known

    def _audit_topic_emergence(self) -> dict:
        candidates = []

        if not (self.corpus_dir and os.path.exists(self.corpus_dir)):
            return {"status": "PASS", "candidates": candidates}

        known_entities = self._known_entities()

        # Pass 1: count entity-phrase frequency across the corpus, and record
        # per-file entity/year occurrences for clustering.
        entity_counts: dict = {}
        file_entities: dict = {}
        file_years: dict = {}
        for filename in sorted(os.listdir(self.corpus_dir)):
            if not filename.endswith(".txt"):
                continue
            filepath = os.path.join(self.corpus_dir, filename)
            with open(filepath, "r", encoding="utf-8") as f:
                text = f.read()

            found = set(self.ENTITY_RE.findall(text))
            unmapped = {e for e in found if e.strip().lower() not in known_entities}
            if unmapped:
                file_entities[filename] = unmapped
                file_years[filename] = set(self.YEAR_RE.findall(text))
            for e in unmapped:
                entity_counts[e] = entity_counts.get(e, 0) + 1

        dense_entities = {e for e, c in entity_counts.items() if c >= self.MIN_ENTITY_DENSITY}
        if not dense_entities:
            return {"status": "PASS", "candidates": candidates}

        # Pass 2: cluster files by shared dense entities (connected components).
        adjacency: dict = {fn: set() for fn in file_entities}
        for a in file_entities:
            for b in file_entities:
                if a < b and (file_entities[a] & file_entities[b] & dense_entities):
                    adjacency[a].add(b)
                    adjacency[b].add(a)

        visited = set()
        clusters = []
        for start in file_entities:
            if start in visited:
                continue
            stack = [start]
            component = []
            while stack:
                node = stack.pop()
                if node in visited:
                    continue
                visited.add(node)
                component.append(node)
                stack.extend(adjacency[node] - visited)
            clusters.append(component)

        for component in clusters:
            cluster_entities = set()
            cluster_years = set()
            for fn in component:
                cluster_entities |= (file_entities[fn] & dense_entities)
                cluster_years |= file_years[fn]
            if len(cluster_entities) < self.MIN_CLUSTER_SIZE:
                continue

            ranked = sorted(cluster_entities, key=lambda e: (-entity_counts[e], e))
            top_entity = ranked[0]
            slug_base = re.sub(r"[^a-z0-9]+", "-", top_entity.lower()).strip("-")
            window = f"{min(cluster_years)}-01-01 to {max(cluster_years)}-12-31" if cluster_years else "unknown"
            slug = f"{slug_base}-{min(cluster_years)}" if cluster_years else slug_base

            candidates.append({
                "title": f"Emergent cluster: {', '.join(ranked[:4])}",
                "slug": slug,
                "domain": slug_base.replace("-", "_"),
                "window": window,
                "entities": ranked,
                "sourceFiles": sorted(component),
                "action": f"python trm/scaffold_topic.py --topic-slug {slug}"
            })

        return {
            "status": "ACTION_REQUIRED" if candidates else "PASS",
            "candidates": candidates
        }

    def _audit_scope_drift(self) -> dict:
        drifted = []
        if self.topics_dir and os.path.exists(self.topics_dir):
            for topic in self._get_active_topics():
                topic_dir = os.path.join(self.topics_dir, topic)
                staging_file = os.path.join(topic_dir, "_kb-sync-staging", "canonical_knowledge.json")
                if not os.path.exists(staging_file):
                    continue

                manifest_path = os.path.join(topic_dir, "topic.manifest.json")
                if not os.path.exists(manifest_path):
                    # No declared time horizon to check against; skip rather than guess.
                    continue
                with open(manifest_path, "r", encoding="utf-8") as mf:
                    manifest = json.load(mf)
                horizon = manifest.get("timeHorizon") or {}
                start, end = horizon.get("start"), horizon.get("end")
                if not start or not end:
                    continue
                declared_window = f"{start} to {end}"

                with open(staging_file, "r", encoding="utf-8") as f:
                    canonical_records = json.load(f)

                for rec in canonical_records:
                    event_date = rec.get("eventDate", "")
                    if not event_date:
                        continue
                    # eventDate may be a bare year/month ("1941" or "1941-01"); pad for lexical comparison.
                    comparable = (event_date + "-01-01")[:10]
                    if comparable < start or comparable > end:
                        drifted.append({
                            "factKey": rec["factKey"],
                            "eventDate": event_date,
                            "declaredWindow": declared_window,
                            "remediation": f"Branch {rec['factKey']} into continuation topic"
                        })

        return {
            "status": "PASS" if not drifted else "ACTION_REQUIRED",
            "driftedRecords": drifted
        }

def print_audit_report(report: dict):
    s = report["summary"]
    print("=" * 80)
    print("TRM TOPIC COVERAGE & COMPLETENESS AUDIT REPORT")
    print("=" * 80)
    print(f"Active Topics Monitored:       {s['activeTopicsMonitored']}")
    print(f"Orphan / Unindexed Sources:    {s['orphanUnindexedSources']}")
    print(f"Emergent Topic Candidates:     {s['emergentTopicCandidates']}")
    print(f"Scope Drift Discrepancies:     {s['scopeDriftDiscrepancies']}")
    print("=" * 80)

    print("\n[1. SOURCE COVERAGE AUDIT]")
    src = report["sourceCoverage"]
    if src["status"] == "PASS":
        print("  -> [PASS] 100% of corpus source files are registered and covered by tasks.")
    else:
        print(f"  -> [ACTION REQUIRED] Found {len(src['orphans'])} unindexed orphan sources:")
        for o in src["orphans"]:
            print(f"     - {o['filename']} ({o['fileHash'][:16]}...)")

    print("\n[2. EMERGENT TOPIC DISCOVERY AUDIT]")
    em = report["topicEmergence"]
    if em["candidates"]:
        print(f"  -> [ACTION REQUIRED] Discovered {len(em['candidates'])} candidate topic(s) needing TRM scaffolding:\n")
        for c in em["candidates"]:
            print(f"     [*] Candidate: {c['title']}")
            print(f"        Slug:      {c['slug']} (Domain: {c['domain']})")
            print(f"        Window:    {c['window']}")
            print(f"        Entities:  {', '.join(c['entities'])}")
            print(f"        Action:    {c['action']}\n")
    else:
        print("  -> [PASS] No unmapped emergent topics detected.")

    print("\n[3. TEMPORAL & BOUNDARY SCOPE DRIFT AUDIT]")
    sd = report["scopeDrift"]
    if sd["status"] == "PASS":
        print("  -> [PASS] All canonical facts remain strictly bounded within topic time horizons.")
    else:
        print(f"  -> [ACTION REQUIRED] Found {len(sd['driftedRecords'])} temporal scope drift discrepancies.")
    print("=" * 80)

def main():
    parser = argparse.ArgumentParser(description="TRM Topic Coverage Auditor")
    parser.add_argument("--topics-dir", required=True, help="Directory containing pilot topics (e.g. ./tests/pilots)")
    parser.add_argument("--corpus-dir", required=False, help="Corpus directory to check for orphan files")
    parser.add_argument("--report", required=False, help="Path to write JSON audit report")
    args = parser.parse_args()

    auditor = TopicCoverageAuditor(args.topics_dir, args.corpus_dir)
    report = auditor.run_audit()

    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)

    print_audit_report(report)

if __name__ == "__main__":
    main()
