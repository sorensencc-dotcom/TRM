// C:\dev\trm\src\cli\commands\report.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { exportBundle } from '../../reporting/exportBundle';
import { renderHtml } from '../../reporting/renderHtml';

const SUPPORTED_THEMES = ['cic'];

export function runReport(
  root: string,
  topicPath: string,
  cliArgs: { theme?: string }
): { bundlePath: string; htmlPath: string } {
  const theme = cliArgs.theme ?? 'cic';
  if (!SUPPORTED_THEMES.includes(theme)) {
    throw new Error(`trm report: unsupported theme "${theme}" (supported: ${SUPPORTED_THEMES.join(', ')})`);
  }

  const bundle = exportBundle(root, topicPath, theme);
  const html = renderHtml(bundle);

  const reportsDir = path.join(root, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const suffix = crypto.randomBytes(2).toString('hex');
  const stamp = `${Date.now()}-${suffix}`;
  const bundlePath = path.join(reportsDir, `${bundle.topicSlug}-${stamp}.json`);
  const htmlPath = path.join(reportsDir, `${bundle.topicSlug}-${stamp}.html`);

  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
  fs.writeFileSync(htmlPath, html);

  return { bundlePath, htmlPath };
}
