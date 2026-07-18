export type NodeStatus = 'container' | 'active';
export type NodeType = 'project' | 'topic' | 'subtopic';

export interface TopicMeta {
  topic: string;
  path: string;
  parent: string | null;
  children: string[];
  version: string;
  created_at: string;
  updated_at: string;
  actors: string[];
  description: string;
  tags: string[];
  status: NodeStatus;
  node_type: NodeType;
}

export interface TrmConfig {
  default_scoring_adapter: string;
  promotion_threshold: number;
  actor_source: 'env' | 'cli-only';
  time_source: 'system' | 'fixed';
}
