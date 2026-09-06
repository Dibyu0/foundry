import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_EXPOSURE_WARNING,
  MAX_ENV_REFS,
  MAX_SECRET_WARNINGS,
  scanBuildEnv,
  scanSiteEnv,
  type ScannedFile,
} from '../src/agent/envNotes.js';
import { writeSiteFile } from '../src/sites.js';

function file(content: string, path = 'app.js'): ScannedFile {
  return { path, content };
}

describe('scanBuildEnv env references', () => {
  it('detects process.env.X with name, file and line', () => {
    const r = scanBuildEnv([file('const k = process.env.API_KEY;')]);
    expect(r.envRefs).toEqual([{ name: 'API_KEY', file: 'app.js', line: 1 }]);
  });

  it('detects the bracket-string form process.env["X"]', () => {
    const r = scanBuildEnv([file('const k = process.env["DATABASE_URL"];')]);
    expect(r.envRefs.map((e) => e.name)).toEqual(['DATABASE_URL']);
  });

  it('detects import.meta.env.X', () => {
    const r = scanBuildEnv([file('const m = import.meta.env.VITE_MODE;')]);
    expect(r.envRefs.map((e) => e.name)).toEqual(['VITE_MODE']);
  });

  it('detects %NAME% batch-style references', () => {
    const r = scanBuildEnv([file('REM set %DATABASE_URL% before starting', 'run.bat')]);
    expect(r.envRefs.map((e) => e.name)).toEqual(['DATABASE_URL']);
  });

  it('detects $NAME and ${NAME} in shell-style comments', () => {
    const r = scanBuildEnv([file('# needs $API_KEY and ${REGION} set', 'deploy.sh')]);
    expect(r.envRefs.map((e) => e.name)).toEqual(['API_KEY', 'REGION']);
  });

  it('reports 1-based line numbers across LF and CRLF content', () => {
    const r = scanBuildEnv([file('one\ntwo\r\nconst k = process.env.TOKEN;\r\nfour')]);
    expect(r.envRefs).toEqual([{ name: 'TOKEN', file: 'app.js', line: 3 }]);
  });

  it('keeps refs from several files attached to their own file', () => {
    const r = scanBuildEnv([file('process.env.A', 'a.js'), file('%API_KEY%', 'b.html')]);
    expect(r.envRefs).toEqual([
      { name: 'A', file: 'a.js', line: 1 },
      { name: 'API_KEY', file: 'b.html', line: 1 },
    ]);
  });

  it('does not flag prose words like PROCESS or a bare process.env mention', () => {
    const r = scanBuildEnv([file('We PROCESS your data with care. process.env is not a thing here.', 'index.html')]);
    expect(r.envRefs).toEqual([]);
  });

  it('does not flag URL encodings or CSS percentages as %NAME%', () => {
    const r = scanBuildEnv([
      file('<a href="/x?q=%E2%80%99">50% off</a>', 'index.html'),
      file('.a { width: 50%; margin: 0 10%; }', 'styles.css'),
    ]);
    expect(r.envRefs).toEqual([]);
  });

  it('only treats $NAME as an env ref inside shell-style comments', () => {
    const r = scanBuildEnv([file('const $TOTAL = 42; // jQuery uses $\nprice: $9.99')]);
    expect(r.envRefs).toEqual([]);
  });

  it('ignores lowercase $names and single-letter $N in comments', () => {
    const r = scanBuildEnv([file('# set $api_key or $A here', 'notes.sh')]);
    expect(r.envRefs).toEqual([]);
  });

  it('dedupes the same reference repeated on one line', () => {
    const r = scanBuildEnv([file('process.env.A || process.env.A')]);
    expect(r.envRefs).toEqual([{ name: 'A', file: 'app.js', line: 1 }]);
  });
});

describe('scanBuildEnv secret warnings', () => {
  it('detects sk-* (OpenAI-shaped) keys', () => {
    const r = scanBuildEnv([file(`const key = "sk-${'a1'.repeat(16)}";`)]);
    expect(r.secretWarnings).toEqual([{ file: 'app.js', line: 1, pattern: 'sk-*' }]);
  });

  it('detects AIza* (Google) keys', () => {
    const r = scanBuildEnv([file(`key = AIza${'bB2'.repeat(12)}`, 'config.js')]);
    expect(r.secretWarnings).toEqual([{ file: 'config.js', line: 1, pattern: 'AIza*' }]);
  });

  it('detects AKIA* (AWS access key ids)', () => {
    const r = scanBuildEnv([file('aws_access_key_id = AKIAIOSFODNN7EXAMPLE')]);
    expect(r.secretWarnings).toEqual([{ file: 'app.js', line: 1, pattern: 'AKIA*' }]);
  });

  it('detects ghp_* (GitHub tokens)', () => {
    const r = scanBuildEnv([file(`token: ghp_${'c3'.repeat(18)}`, 'config.js')]);
    expect(r.secretWarnings).toEqual([{ file: 'config.js', line: 1, pattern: 'ghp_*' }]);
  });

  it('reports the line the secret sits on', () => {
    const r = scanBuildEnv([file(`line one\nline two\nconst k = "sk-${'d4'.repeat(16)}";`)]);
    expect(r.secretWarnings).toEqual([{ file: 'app.js', line: 3, pattern: 'sk-*' }]);
  });

  it('does not flag short lookalikes', () => {
    const r = scanBuildEnv([file('sk-short AIzaSyX AKIA123 ghp_abc are all too short')]);
    expect(r.secretWarnings).toEqual([]);
  });

  it('never copies the secret text into the report', () => {
    const secret = `sk-${'z9'.repeat(24)}`;
    const r = scanBuildEnv([file(`const k = "${secret}";`)]);
    expect(r.secretWarnings).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe('scanBuildEnv caps and report shape', () => {
  it('caps env refs at MAX_ENV_REFS and marks the report truncated', () => {
    const lines = Array.from({ length: MAX_ENV_REFS + 10 }, (_, i) => `process.env.K${i}`);
    const r = scanBuildEnv([file(lines.join('\n'))]);
    expect(r.envRefs).toHaveLength(MAX_ENV_REFS);
    expect(r.truncated).toBe(true);
    expect(r.envRefs[0]?.name).toBe('K0');
  });

  it('does not mark truncated when findings exactly fill the cap', () => {
    const lines = Array.from({ length: MAX_ENV_REFS }, (_, i) => `process.env.K${i}`);
    const r = scanBuildEnv([file(lines.join('\n'))]);
    expect(r.envRefs).toHaveLength(MAX_ENV_REFS);
    expect(r.truncated).toBe(false);
  });

  it('caps secret warnings at MAX_SECRET_WARNINGS', () => {
    const lines = Array.from({ length: MAX_SECRET_WARNINGS + 5 }, (_, i) => `k${i} = "sk-${'q7'.repeat(20)}"`);
    const r = scanBuildEnv([file(lines.join('\n'))]);
    expect(r.secretWarnings).toHaveLength(MAX_SECRET_WARNINGS);
    expect(r.truncated).toBe(true);
  });

  it('honors custom caps', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `process.env.K${i}`);
    const r = scanBuildEnv([file(lines.join('\n'))], { maxRefs: 2 });
    expect(r.envRefs.map((e) => e.name)).toEqual(['K0', 'K1']);
    expect(r.truncated).toBe(true);
  });

  it('returns an empty, untruncated report for empty input', () => {
    expect(scanBuildEnv([])).toEqual({
      envRefs: [],
      secretWarnings: [],
      truncated: false,
      clientExposureWarning: CLIENT_EXPOSURE_WARNING,
    });
    const r = scanBuildEnv([file('')]);
    expect(r.envRefs).toEqual([]);
    expect(r.secretWarnings).toEqual([]);
  });

  it('carries the client-side exposure warning copy', () => {
    expect(CLIENT_EXPOSURE_WARNING).toMatch(/static site/i);
    expect(CLIENT_EXPOSURE_WARNING).toMatch(/every viewer/i);
    expect(CLIENT_EXPOSURE_WARNING).toMatch(/never embed secrets/i);
    expect(CLIENT_EXPOSURE_WARNING).toMatch(/backend/i);
    expect(scanBuildEnv([]).clientExposureWarning).toBe(CLIENT_EXPOSURE_WARNING);
  });
});

describe('scanSiteEnv', () => {
  it('scans a real site directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-env-'));
    const sitesRoot = path.join(dir, 'sites');
    await writeSiteFile(sitesRoot, 'site123', 'app.js', 'const k = process.env.MY_TOKEN;');
    await writeSiteFile(sitesRoot, 'site123', 'styles.css', '.a { color: red; }');
    const r = await scanSiteEnv(sitesRoot, 'site123');
    expect(r.envRefs).toEqual([{ name: 'MY_TOKEN', file: 'app.js', line: 1 }]);
    expect(r.secretWarnings).toEqual([]);
  });

  it('returns an empty report when the site has no files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-env-'));
    const r = await scanSiteEnv(path.join(dir, 'sites'), 'nope123');
    expect(r).toEqual({
      envRefs: [],
      secretWarnings: [],
      truncated: false,
      clientExposureWarning: CLIENT_EXPOSURE_WARNING,
    });
  });
});
