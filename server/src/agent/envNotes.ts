import { listSiteFiles, readSiteFile, SiteError } from '../sites.js';

/**
 * Honest-static-edition env/secrets scan. Generated sites are static: every
 * byte ships to every viewer, so there is no server-side environment to read
 * and no safe place for secrets. This scans the files a build produced for
 * env-var-shaped references and common secret-looking literals and reports
 * them (locations and pattern ids only, never the secret text) so the
 * workspace can warn before the user downloads or shares the site.
 */

export const MAX_ENV_REFS = 50;
export const MAX_SECRET_WARNINGS = 50;

export const CLIENT_EXPOSURE_WARNING =
  'Anything in a static site ships to every viewer. Never embed secrets in a static site: a generated app must call your own backend for secrets, which keeps them server-side and out of the shipped files.';

export interface EnvRef {
  /** Variable name without decoration (process.env. / %...% / $ stripped). */
  name: string;
  file: string;
  /** 1-based line number. */
  line: number;
}

export type SecretPatternId =
  | 'sk-*'
  | 'sk_*'
  | 'AIza*'
  | 'AKIA*'
  | 'ghp_*'
  | 'github_pat_*'
  | 'xox*'
  | 'SG.*'
  | 'PEM private key';

export interface SecretWarning {
  file: string;
  /** 1-based line number. The matched text itself is never reported. */
  line: number;
  pattern: SecretPatternId;
}

export interface EnvReport {
  envRefs: EnvRef[];
  secretWarnings: SecretWarning[];
  /** true when MAX_ENV_REFS or MAX_SECRET_WARNINGS cut a list short. */
  truncated: boolean;
  /** Ready-to-show guidance for the workspace panel. */
  clientExposureWarning: string;
}

export interface ScannedFile {
  path: string;
  content: string;
}

export interface ScanOptions {
  maxRefs?: number;
  maxWarnings?: number;
}

// process.env.X / import.meta.env.X, dot and bracket-string forms.
const DOT_ENV_RE =
  /(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]\])/g;

// %NAME% (batch style). Three characters minimum: two-character uppercase
// tokens between percents are almost always URL encodings (%E2%80%99).
const BATCH_ENV_RE = /%([A-Z_][A-Z0-9_]{2,})%/g;

// $NAME / ${NAME}, gated to shell-comment lines (first non-blank char '#') -
// an unanchored $NAME scan would flag JS $-identifiers and prices.
const SHELL_ENV_RE = /\$(?:\{([A-Z_][A-Z0-9_]{1,})\}|([A-Z_][A-Z0-9_]{1,}))/g;

const SHELL_COMMENT_RE = /^\s*#/;

// Minimum lengths keep everyday lookalikes ('sk-short', 'ghp_abc') out; the
// lookarounds keep matches from starting mid-token. Values are matched only
// to locate the line - they are never copied into the report.
const SECRET_PATTERNS: ReadonlyArray<{ id: SecretPatternId; re: RegExp }> = [
  { id: 'sk-*', re: /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}/g },
  // Stripe secret keys (the most common key an AI builder embeds).
  { id: 'sk_*', re: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'AIza*', re: /(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{20,}/g },
  { id: 'AKIA*', re: /(?<![0-9A-Z])AKIA[0-9A-Z]{16}(?![0-9A-Z])/g },
  { id: 'ghp_*', re: /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{30,}/g },
  // GitHub fine-grained PATs and the other token families in the gh* space.
  { id: 'github_pat_*', re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{30,}/g },
  { id: 'ghp_*', re: /(?<![A-Za-z0-9_])gh[osr]_[A-Za-z0-9]{30,}/g },
  // Slack bot/app/user tokens.
  { id: 'xox*', re: /(?<![A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{16,}/g },
  // SendGrid keys (SG.<~22>.<~43>).
  { id: 'SG.*', re: /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  // PEM private key headers — a fixed literal with zero false-positive risk.
  { id: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g },
];

export function emptyEnvReport(): EnvReport {
  return { envRefs: [], secretWarnings: [], truncated: false, clientExposureWarning: CLIENT_EXPOSURE_WARNING };
}

/** Pure scan over caller-supplied files (injectable; no fs). */
export function scanBuildEnv(files: readonly ScannedFile[], opts: ScanOptions = {}): EnvReport {
  const maxRefs = opts.maxRefs ?? MAX_ENV_REFS;
  const maxWarnings = opts.maxWarnings ?? MAX_SECRET_WARNINGS;
  const report = emptyEnvReport();
  const seenRefs = new Set<string>();
  const seenSecrets = new Set<string>();
  let refsFull = false;
  let secretsFull = false;

  const addRef = (name: string, file: string, line: number): void => {
    const key = `${file} ${line} ${name}`;
    if (seenRefs.has(key)) return;
    if (report.envRefs.length >= maxRefs) {
      refsFull = true;
      report.truncated = true;
      return;
    }
    seenRefs.add(key);
    report.envRefs.push({ name, file, line });
  };

  const addSecret = (pattern: SecretPatternId, file: string, line: number): void => {
    const key = `${file} ${line} ${pattern}`;
    if (seenSecrets.has(key)) return;
    if (report.secretWarnings.length >= maxWarnings) {
      secretsFull = true;
      report.truncated = true;
      return;
    }
    seenSecrets.add(key);
    report.secretWarnings.push({ file, line, pattern });
  };

  for (const file of files) {
    if (refsFull && secretsFull) break;
    const lines = file.content.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (refsFull && secretsFull) break;
      const text = lines[i] ?? '';
      const lineNo = i + 1;
      if (!refsFull) {
        for (const m of text.matchAll(DOT_ENV_RE)) {
          const name = m[1] ?? m[2];
          if (name !== undefined) addRef(name, file.path, lineNo);
        }
        for (const m of text.matchAll(BATCH_ENV_RE)) {
          if (m[1] !== undefined) addRef(m[1], file.path, lineNo);
        }
        if (SHELL_COMMENT_RE.test(text)) {
          for (const m of text.matchAll(SHELL_ENV_RE)) {
            const name = m[1] ?? m[2];
            if (name !== undefined) addRef(name, file.path, lineNo);
          }
        }
      }
      if (!secretsFull) {
        for (const { id, re } of SECRET_PATTERNS) {
          for (const _match of text.matchAll(re)) addSecret(id, file.path, lineNo);
        }
      }
    }
  }
  return report;
}

/** Scans the site a build wrote on disk (one-liner for the orchestrator). */
export async function scanSiteEnv(sitesRoot: string, id: string, opts: ScanOptions = {}): Promise<EnvReport> {
  const entries = await listSiteFiles(sitesRoot, id);
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    try {
      files.push({ path: entry.path, content: (await readSiteFile(sitesRoot, id, entry.path)).toString('utf8') });
    } catch (err) {
      // A file can disappear between list and read while a build is still
      // writing; the report covers the files that exist at scan time.
      if (!(err instanceof SiteError && err.code === 'NOT_FOUND')) throw err;
    }
  }
  return scanBuildEnv(files, opts);
}
