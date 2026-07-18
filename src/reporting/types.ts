export interface ReportBundleFact {
  text: string;
  sourceId: string;
  confidence: number;
  categories: string[];
}

export interface ReportBundleSource {
  id: string;
  type: string;
  title: string;
  origin: string;
  url: string;
  addedAt: string;
}

export interface ReportBundle {
  version: string;
  topicPath: string;
  topicSlug: string;
  generatedAt: string;
  sourceCount: number;
  factCount: number;
  stats: {
    sourceCount: number;
    factCount: number;
  };
  facts: ReportBundleFact[];
  sources: ReportBundleSource[];
  theme: string;
}
