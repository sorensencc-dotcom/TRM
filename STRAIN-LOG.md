# PPP Texas TRM Evidence Engine Strain Log

This log records areas where the TRM evidence engine encounters friction when processing structured bulk-row FOIA datasets (SBA PPP Texas subset) rather than narrative archive documents.

---

### Entry 1: Non-UTF-8 Encoding in SBA FOIA Datasets
- **What was tried:** Reading SBA PPP CSV files using standard UTF-8 stream decoding.
- **What happened:** SBA FOIA CSV files contain ISO-8859-1 (Latin-1) characters (such as accent marks in business names like `0xE9` or `0xF1`). Default UTF-8 decoders produce replacement characters or throw parser errors on high-byte sequences.
- **Engine subsystem:** Intake and Ingestion Stream (`src/ppp/sbaIngest.ts`).
- **Resolution:** Enforce `latin1` encoding explicitly at the file read stream boundary before feeding lines into the CSV tokenizer.

---

### Entry 2: Bulk-Row Volume vs Claim Graph Scale
- **What was tried:** Evaluating ingestion of the full Texas subset (938,551 rows, ~$62.75 billion) directly into TRM's in-memory fact extract model (`extract.json`).
- **What happened:** Materializing nearly one million individual claim nodes exceeds heap thresholds, bogs down extract serialization, and dilutes the core research graph with administrative boilerplate.
- **Engine subsystem:** Core Claim Storage and Memory Limits.
- **Resolution:** Bulk rows are stored in a local SQLite database configured with Write-Ahead Logging (`PRAGMA journal_mode = WAL;`) and synchronous mode set to `NORMAL`. Indexes cover `loan_number`, `borrower_name_norm`, `borrower_zip`, and `current_approval_amount`. Claims materialize into the evidence graph only when a row is tied to an active lead or test case.

---

### Entry 3: Span Hashing Across Machine File Paths
- **What was tried:** Hashing raw row spans using fully-qualified file paths (`sha256(full_path + ...)`).
- **What happened:** Absolute file paths vary across environments (e.g. Windows developer workstations vs CI or Linux containers), causing span verification to fail on identical datasets.
- **Engine subsystem:** Lineage and Span Hash (`src/ppp/spanHash.ts`).
- **Resolution:** Strip directory prefixes and compute hashes using the file basename (e.g. `ppp_foia_20240930_tx.csv`). Keys are sorted alphabetically, string values are trimmed, and numeric approval amounts are preserved strictly as raw text to avoid floating-point drift.

---

### Entry 4: Entity Name Normalization Boundary Collisions
- **What was tried:** Stripping corporate suffixes (`INC`, `LLC`, `CORP`, `CO`, `DBA`) via regular expression substring replacement.
- **What happened:** Substring replacement risks corrupting legitimate root business names containing those letter sequences (e.g. `COMPANY` becoming `MPANY` or `INCORPORATED` being partially truncated).
- **Engine subsystem:** Entity Matcher (`src/ppp/entityMatcher.ts`).
- **Resolution:** Tokenize the sanitized uppercase name and strip known corporate entity types only from trailing tokens at word boundaries.

---

### Entry 5: DBA and Composite Trade Name Matching
- **What was tried:** Matching borrower names directly against exclusion rows containing combined legal and trade names.
- **What happened:** Entities listed as `LEGAL NAME DBA TRADE NAME` in court releases fail direct exact matches against SBA rows where only the legal or trade name is present.
- **Engine subsystem:** Entity Matcher (`src/ppp/entityMatcher.ts`).
- **Resolution:** Both the borrower name and exclusion entity strings are split into candidate names using `extractDbaCandidates`. Matching succeeds if either candidate aligns with a normalized defendant or entity record.

---

### Entry 6: Open-Gap Handling with Non-Exhaustive Exclusions
- **What was tried:** Evaluating whether an absence of matching exclusion rows can close a triage inquiry.
- **What happened:** The initial exclusion list contains 64 releases across Texas districts and is explicitly non-exhaustive (WDTX, South Texas, and late 2026 sweeps are known gaps). Interpreting a non-match as clearance creates a severe false-negative risk.
- **Engine subsystem:** Gap Registry (`src/ppp/gapRegistry.ts`).
- **Resolution:** Enforce strict keep-open invariants. A non-match in the exclusion list leaves the research gap open (`PPP-GAP-xx`). A gap may only be resolved by an official public court docket or record.
