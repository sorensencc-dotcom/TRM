---
title: "Multimodal Ingestion & Media Pipeline"
status: active
owner: chris
last-reviewed: 2026-09-26
brand: cic
---

# Multimodal Ingestion & Media Pipeline

**Type:** Architecture & Operations Guide  
**Domain:** trm | ingestion | vision | whisper  
**Status:** Active  
**Last Updated:** 2026-08-23 via Log entry [[SemanticUpdateDate]]

---

## Definition

The Multimodal Ingestion & Media Pipeline handles parallel ingestion, OCR scanning, vision scene analysis, video keyframe extraction, and local speech-to-text transcription. It transforms unstructured media into pinned source text artifacts (`corpus/<source_id>.txt`) locked with SHA-256 digests.

---

## Why It Matters

Primary historical and operational evidence spans diverse media formats beyond raw text, including declassified PDFs, scanned factory layouts, historical video footage, and audio interviews. Standardizing these formats into cryptographic source targets enables unified entity extraction and rigorous audit rule checking across topic packs (`topic.pack.v1`).

---

## Architecture & Flow Diagram

![TRM multimodal media ingestion architecture: text normalizer, vision API, ffmpeg keyframe extractor, whisper.cpp speech-to-text, and SHA-256 corpus pinning.](multimodal-ingestion.png)

<details>
<summary>Mermaid source (kept for editing — the image above is what renders on the wiki)</summary>

```mermaid
flowchart TD
    classDef inputStyle fill:#1e293b,stroke:#64748b,stroke-width:2px,color:#f8fafc;
    classDef procStyle fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f8fafc;
    classDef mediaStyle fill:#1e1b4b,stroke:#818cf8,stroke-width:2px,color:#f8fafc;
    classDef outStyle fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#f8fafc;

    subgraph Inputs["1. Unstructured Media Ingestion"]
        IN_FILE["Input Media File<br/>(Text, PDF, Image, Video, Audio)"]:::inputStyle
        CLASSIFY["Media Type Classifier"]:::procStyle
        IN_FILE --> CLASSIFY
    end

    subgraph Transformers["2. Media Transformation Engines"]
        TEXT_ENGINE["Text Normalizer<br/>(pdf-parse / text)"]:::mediaStyle
        OCR_ENGINE["CIC Vision / OCR API<br/>(Image Scene & Text)"]:::mediaStyle
        VIDEO_ENGINE["ffmpeg Keyframe Extractor<br/>(Frame Splitting)"]:::mediaStyle
        AUDIO_ENGINE["whisper.cpp Engine<br/>(Speech-to-Text)"]:::mediaStyle

        CLASSIFY -->|Text / PDF| TEXT_ENGINE
        CLASSIFY -->|Image / Scan| OCR_ENGINE
        CLASSIFY -->|Video| VIDEO_ENGINE
        CLASSIFY -->|Audio| AUDIO_ENGINE

        VIDEO_ENGINE -->|Keyframes| OCR_ENGINE
        VIDEO_ENGINE -->|Audio Track| AUDIO_ENGINE
    end

    subgraph Output["3. Corpus Pinning & Topic Pack Integration"]
        SYNTH["Multimodal Content Synthesizer"]:::procStyle
        PIN_CORPUS["corpus/source_catalog.json<br/>(SHA-256 Digest & Byte Length)"]:::outStyle
        SPEC_TARGET["specs/task-*.json<br/>(research.task.v1 Target)"]:::outStyle

        TEXT_ENGINE --> SYNTH
        OCR_ENGINE --> SYNTH
        AUDIO_ENGINE --> SYNTH

        SYNTH --> PIN_CORPUS
        PIN_CORPUS --> SPEC_TARGET
    end
```

</details>

---

## Supported Media Formats

| Media Category | File Extensions | Processing Pipeline | Engine / Dependencies |
| :--- | :--- | :--- | :--- |
| **Text Documents** | `.txt`, `.md`, `.json`, `.csv` | Direct ingestion + SHA-256 hash | Built-in Node.js runtime |
| **PDF Documents** | `.pdf` | Text extraction + layout normalization | `pdf-parse` / Local parser |
| **Images & Scans** | `.jpg`, `.jpeg`, `.png`, `.webp`, `.tiff` | OCR + Visual scene analysis | CIC Vision Service (`CIC_INGESTION_URL`) |
| **Video Recordings** | `.mp4`, `.mov`, `.avi`, `.mkv` | Keyframe extraction + Vision analysis | `ffmpeg`, `ffprobe`, CIC Vision |
| **Audio Tracks** | `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac` | Speech-to-text transcription | `whisper.cpp` (`TRM_WHISPER_BIN`) |

---

## Concurrency & Hardware Tuning

Tuning environment variables optimizes GPU/CPU allocation during batch ingestion:

| Environment Variable | Default | Recommended Setting | Description |
| :--- | :--- | :--- | :--- |
| `TRM_IO_CONCURRENCY` | `8` | `8 - 16` | Maximum concurrent files processed for hashing and classification. |
| `TRM_VISION_CONCURRENCY` | `4` | `2 - 8` | Cap on concurrent requests sent to the local/remote Vision API. |
| `TRM_FFMPEG_CONCURRENCY` | `2` | `2 - 4` | Max concurrent ffmpeg subprocesses for frame extraction. |
| `TRM_FRAME_ANALYSIS_CONCURRENCY` | `3` | `2 - 6` | Concurrent visual analysis calls per individual video file. |
| `TRM_WHISPER_CONCURRENCY` | `1` | `1` | Max concurrent whisper transcriptions (serialized to protect CPU/VRAM). |

---

## Binary Path Configuration

Set binary environment variables for video frame extraction and audio transcription:

```bash
# Path to ffmpeg and ffprobe executables
export TRM_FFMPEG_PATH="/usr/bin/ffmpeg"
export TRM_FFPROBE_PATH="/usr/bin/ffprobe"

# Path to whisper.cpp binary and ggml model file
export TRM_WHISPER_BIN="/usr/local/bin/whisper-cli"
export TRM_WHISPER_MODEL="$HOME/.cache/whisper/ggml-base.en.bin"
```

---

## Cross-References

- See [[Architecture & Data Model]] for source catalog pinning details
- See [[CLI Reference & Commands]] for `trm ingest-dir` syntax
- See [[Security Guardrails & Root Safety]] for zero-trust raw source protection
