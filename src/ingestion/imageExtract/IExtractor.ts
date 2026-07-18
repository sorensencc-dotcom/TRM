// src/ingestion/imageExtract/IExtractor.ts
// Vendored from cic-ingestion/src/extractors/IExtractor.ts. Mock-only stub —
// see docs/meta/specs/2026-07-18-trm-harvester-mock-wiring-design.md for the
// real-vision migration plan.

export class IExtractor {
  async extract(input: any): Promise<any> {
    throw new Error("not implemented");
  }
}
