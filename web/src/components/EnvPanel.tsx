import type { ReactElement } from 'react';

/* Mirrors the report produced by server/src/agent/envNotes.ts. The server is
 * the source of truth: it attaches the report to build state as `envNotes`
 * and streams it as an `env` SSE event (see integrator wire-up notes). */

export interface EnvRef {
  name: string;
  file: string;
  line: number;
}

export interface SecretWarning {
  file: string;
  line: number;
  pattern: string;
}

export interface EnvReport {
  envRefs: EnvRef[];
  secretWarnings: SecretWarning[];
  truncated?: boolean;
  clientExposureWarning?: string;
}

/* Same guidance the server puts in report.clientExposureWarning, kept as a
 * fallback for build snapshots that predate the field. */
const EXPOSURE_GUIDANCE =
  'Anything in a static site ships to every viewer. Never embed secrets in a static site: a generated app must call your own backend for secrets, which keeps them server-side and out of the shipped files.';

const REFS_NOTE =
  'A static site has no server-side environment, so these names resolve to nothing on their own. Provide real values at runtime from your own backend instead of baking them into the shipped files.';

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function line(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
}

/* Candidate for web/src/lib/pure.ts (owned by WEBTYPES) - api.ts normState
 * should call this on the build-state `envNotes` payload. Normalizes
 * generously and never invents findings. */
export function normalizeEnvReport(raw: unknown): EnvReport | null {
  const r = rec(raw);
  if (!r) return null;
  const envRefs = (Array.isArray(r.envRefs) ? r.envRefs : [])
    .map((e): EnvRef | null => {
      const o = rec(e);
      if (!o) return null;
      const name = str(o.name);
      const file = str(o.file) ?? str(o.path);
      const ln = line(o.line);
      if (!name || !file || ln === undefined) return null;
      return { name, file, line: ln };
    })
    .filter((e): e is EnvRef => e !== null);
  const secretWarnings = (Array.isArray(r.secretWarnings) ? r.secretWarnings : [])
    .map((w): SecretWarning | null => {
      const o = rec(w);
      if (!o) return null;
      const file = str(o.file) ?? str(o.path);
      const pattern = str(o.pattern);
      const ln = line(o.line);
      if (!file || !pattern || ln === undefined) return null;
      return { file, line: ln, pattern };
    })
    .filter((w): w is SecretWarning => w !== null);
  const report: EnvReport = { envRefs, secretWarnings };
  if (r.truncated === true) report.truncated = true;
  const warning = str(r.clientExposureWarning);
  if (warning) report.clientExposureWarning = warning;
  return report;
}

interface EnvPanelProps {
  /** Per-build scan from the server (build.envNotes); null/undefined while no scan has run. */
  report?: EnvReport | null;
}

export function EnvPanel({ report }: EnvPanelProps): ReactElement | null {
  if (report === null || report === undefined) return null;
  const { envRefs, secretWarnings } = report;
  const isEmpty = envRefs.length === 0 && secretWarnings.length === 0;

  return (
    <section className="env-panel" aria-label="Environment and secrets scan">
      <h3 className="env-title">Environment scan</h3>

      {isEmpty && <p className="env-empty muted">No environment references</p>}

      {secretWarnings.length > 0 && (
        <div className="env-warning" role="alert">
          <p className="env-warning-title">Possible secrets in shipped files</p>
          <ul className="env-list">
            {secretWarnings.map((w) => (
              <li key={`${w.file}:${w.line}:${w.pattern}`}>
                <code>
                  {w.file}:{w.line}
                </code>{' '}
                matches <code>{w.pattern}</code>
              </li>
            ))}
          </ul>
          <p className="env-warning-copy">{report.clientExposureWarning ?? EXPOSURE_GUIDANCE}</p>
        </div>
      )}

      {envRefs.length > 0 && (
        <div className="env-refs">
          <p className="env-refs-title">Environment references</p>
          <ul className="env-list">
            {envRefs.map((r) => (
              <li key={`${r.file}:${r.line}:${r.name}`}>
                <code>{r.name}</code> in{' '}
                <code>
                  {r.file}:{r.line}
                </code>
              </li>
            ))}
          </ul>
          <p className="env-refs-note muted">{REFS_NOTE}</p>
        </div>
      )}

      {report.truncated === true && (
        <p className="env-truncated muted">Lists were capped at the report limit; the earliest findings are shown.</p>
      )}
    </section>
  );
}
