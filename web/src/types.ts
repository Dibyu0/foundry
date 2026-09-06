/** Shared contract types for the Foundry frontend. Mirrors the REST/SSE contract
 *  implemented by the server workstreams — keep in sync with the project brief. */

export type Phase = 'INTAKE' | 'PLANNED' | 'BUILDING' | 'REVIEW' | 'DONE' | 'ERROR' | 'CANCELLED';

export const PHASES: readonly Phase[] = ['INTAKE', 'PLANNED', 'BUILDING', 'REVIEW', 'DONE', 'ERROR', 'CANCELLED'];

export function isRunning(phase: Phase | undefined): boolean {
  return phase === 'INTAKE' || phase === 'PLANNED' || phase === 'BUILDING' || phase === 'REVIEW';
}

export type RoleId = 'planner' | 'design' | 'copy' | 'builder' | 'reviewer';

export const ROLE_IDS: readonly RoleId[] = ['planner', 'design', 'copy', 'builder', 'reviewer'];

export const ROLE_LABELS: Record<RoleId, string> = {
  planner: 'Planner',
  design: 'Design',
  copy: 'Copy',
  builder: 'Builder',
  reviewer: 'Reviewer',
};

export function asRoleId(name: string): RoleId | null {
  const n = name.toLowerCase().replace(/\[role:|\]/g, '').trim();
  return (ROLE_IDS as readonly string[]).includes(n) ? (n as RoleId) : null;
}

export type RoleState = 'idle' | 'active' | 'done' | 'error';

export interface ActivityEvent {
  role: string;
  state: RoleState;
  note?: string;
}

export interface ChatMessage {
  role: 'user' | 'agent' | 'system';
  text: string;
  agent?: string;
  ts?: number;
}

export interface QuestionOption {
  id?: string;
  label: string;
}

export interface PendingQuestion {
  id: string;
  text: string;
  options: QuestionOption[];
}

export interface PlanStep {
  title: string;
  files: string[];
  done: boolean;
}

export interface Plan {
  summary: string;
  designDirection?: string;
  steps: PlanStep[];
}

export interface SiteFile {
  path: string;
  bytes?: number;
  content?: string;
}

export interface ReviewIssue {
  severity: 'info' | 'warn' | 'error';
  text: string;
  file?: string;
}

export interface BuildState {
  id: string;
  phase: Phase;
  brief: string;
  messages: ChatMessage[];
  pendingQuestion?: PendingQuestion | null;
  plan?: Plan | null;
  files: SiteFile[];
  issues: ReviewIssue[];
  siteUrl?: string;
  error?: string;
  createdAt?: number;
}

export interface BuildSummary {
  id: string;
  phase: Phase;
  brief: string;
  createdAt?: number;
}

export interface ServerConfig {
  provider: string;
  endpoint: string;
  model: string;
  hasKey: boolean;
}

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'lost';

export type BuildEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'message'; message: ChatMessage }
  | { type: 'question'; question: PendingQuestion }
  | { type: 'plan'; plan: Plan }
  | { type: 'file'; file: SiteFile }
  | { type: 'activity'; activity: ActivityEvent }
  | { type: 'review'; issues: ReviewIssue[] }
  | { type: 'done'; siteUrl?: string }
  | { type: 'error'; error: string };
