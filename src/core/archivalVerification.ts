import { readRawEnvelope, rawSourcePath, writeRawEnvelope } from './rawSource';

export interface FrameVerification {
  timecodeIn: string;
  timecodeOut: string;
  attestation: string;
  verifiedAt: string;
}

function parseTimecode(value: string): number {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(value)) throw new Error(`Invalid timecode: ${value}`);
  const [hours, minutes, seconds] = value.split(':').map(Number);
  if (minutes > 59 || seconds > 59) throw new Error(`Invalid timecode: ${value}`);
  return hours * 3600 + minutes * 60 + seconds;
}

export function promoteArchivalFrameVerification(
  root: string,
  topicPath: string,
  sourceId: string,
  verification: Omit<FrameVerification, 'verifiedAt'>
): FrameVerification {
  if (!verification.attestation.trim()) throw new Error('Attestation is required');
  if (parseTimecode(verification.timecodeOut) < parseTimecode(verification.timecodeIn)) {
    throw new Error('timecode_out must not precede timecode_in');
  }
  const envelope = readRawEnvelope(root, topicPath, sourceId);
  if (!envelope) throw new Error(`Raw source envelope not found: ${sourceId}`);
  if (!envelope.archival) throw new Error(`Source is not an archival source: ${sourceId}`);
  if (envelope.archival.claimStatus !== 'catalog_only') throw new Error(`Source is already frame-verified: ${sourceId}`);
  const frameVerification: FrameVerification = { ...verification, verifiedAt: new Date().toISOString() };
  envelope.archival.claimStatus = 'frame_verified';
  envelope.frameVerification = frameVerification;
  writeRawEnvelope(root, topicPath, envelope);
  return frameVerification;
}
