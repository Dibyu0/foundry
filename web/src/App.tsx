import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  createBuild,
  getBuild,
  getConfig,
  listBuilds,
  openBuildEvents,
  postAnswer,
  postApprove,
  postAutopilot,
  postCancel,
  postEdit,
  type StreamHandle,
} from './api';
import type {
  ActivityEvent,
  BuildEvent,
  BuildState,
  BuildSummary,
  ChatMessage,
  Phase,
  Plan,
  ServerConfig,
  StreamStatus,
} from './types';
import { isRunning } from './types';
import { errorMessage } from './format';
import { Layout } from './components/Layout';
import { SetupCard } from './components/SetupCard';
import { ChatColumn } from './components/ChatColumn';
import { QuestionCard } from './components/QuestionCard';
import { PlanView } from './components/PlanView';
import { AgentTimeline } from './components/AgentTimeline';
import { Workspace } from './components/Workspace';

function phaseBanner(phase: Phase): string {
  switch (phase) {
    case 'INTAKE':
      return 'Understanding your brief';
    case 'PLANNED':
      return 'Plan ready — review and approve it below';
    case 'BUILDING':
      return 'Building the site';
    case 'REVIEW':
      return 'Reviewing the build';
    case 'DONE':
      return 'Build complete';
    case 'ERROR':
      return 'Build failed';
    case 'CANCELLED':
      return 'Build cancelled';
  }
}

function messageKey(m: ChatMessage): string {
  return `${m.role}:${m.agent ?? ''}:${m.text}`;
}

export function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);
  /* Manual open via the top-bar provider pill (auto-show still uses setupDismissed). */
  const [setupOpen, setSetupOpen] = useState(false);

  const [builds, setBuilds] = useState<BuildSummary[]>([]);
  const [buildsLoading, setBuildsLoading] = useState(false);
  const [buildsError, setBuildsError] = useState<string | null>(null);

  const [current, setCurrent] = useState<BuildState | null>(null);
  const [buildLoading, setBuildLoading] = useState(false);
  const [activity, setActivity] = useState<Record<string, ActivityEvent>>({});
  const [liveText, setLiveText] = useState<Record<string, string>>({});
  const [autopilot, setAutopilotState] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('foundry.autopilot') === '1';
    } catch {
      return false;
    }
  });
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle');
  const [approved, setApproved] = useState(false);

  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [approving, setApproving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(false);

  const streamRef = useRef<StreamHandle | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const loadTokenRef = useRef(0);
  const seenMessagesRef = useRef<Set<string>>(new Set());
  const noticeTimer = useRef<number | undefined>(undefined);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const notify = useCallback((kind: 'info' | 'error', text: string) => {
    setNotice({ kind, text });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  /* ------------------------------ config ------------------------------ */

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      setConfig(await getConfig());
    } catch (e) {
      setConfigError(errorMessage(e));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  /* ------------------------------ history ----------------------------- */

  const refreshBuilds = useCallback(async () => {
    setBuildsLoading(true);
    setBuildsError(null);
    try {
      setBuilds(await listBuilds());
    } catch (e) {
      setBuildsError(errorMessage(e));
    } finally {
      setBuildsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshBuilds();
  }, [refreshBuilds]);

  /* ---------------------------- build state --------------------------- */

  const seedMessages = useCallback((msgs: ChatMessage[]) => {
    seenMessagesRef.current = new Set(msgs.map(messageKey));
  }, []);

  const refetchCurrent = useCallback(
    async (id: string) => {
      try {
        const state = await getBuild(id);
        if (currentIdRef.current !== id) return;
        seedMessages(state.messages);
        setCurrent(state);
      } catch (e) {
        notify('error', errorMessage(e));
      }
    },
    [notify, seedMessages],
  );

  const applyEvent = useCallback(
    (ev: BuildEvent) => {
      switch (ev.type) {
        case 'phase':
          setCurrent((c) => {
            if (!c || c.phase === ev.phase) return c;
            return {
              ...c,
              phase: ev.phase,
              pendingQuestion: ev.phase === 'INTAKE' ? (c.pendingQuestion ?? null) : null,
              messages: [...c.messages, { role: 'system', text: phaseBanner(ev.phase) }],
            };
          });
          if (ev.phase === 'REVIEW') {
            // backfill file contents the stream may have only announced
            const id = currentIdRef.current;
            if (id) void refetchCurrent(id);
          }
          break;
        case 'message':
          setCurrent((c) => {
            if (!c) return c;
            const key = messageKey(ev.message);
            if (seenMessagesRef.current.has(key)) return c;
            seenMessagesRef.current.add(key);
            return { ...c, messages: [...c.messages, ev.message] };
          });
          if (ev.message.role === 'agent' && ev.message.agent !== undefined) {
            const role = ev.message.agent.toLowerCase();
            setLiveText((m) => {
              if (!(role in m)) return m;
              const next = { ...m };
              delete next[role];
              return next;
            });
          }
          break;
        case 'question':
          setCurrent((c) => (c ? { ...c, pendingQuestion: ev.question } : c));
          break;
        case 'plan':
          setCurrent((c) => (c ? { ...c, plan: ev.plan } : c));
          break;
        case 'file':
          setCurrent((c) => {
            if (!c) return c;
            const idx = c.files.findIndex((f) => f.path === ev.file.path);
            const files =
              idx < 0
                ? [...c.files, ev.file]
                : c.files.map((f, i) =>
                    i === idx ? { ...f, ...ev.file, content: ev.file.content ?? f.content } : f,
                  );
            return { ...c, files };
          });
          break;
        case 'activity':
          setActivity((a) => ({ ...a, [ev.activity.role.toLowerCase()]: ev.activity }));
          if (ev.activity.state !== 'active') {
            setLiveText((m) => {
              const role = ev.activity.role.toLowerCase();
              if (!(role in m)) return m;
              const next = { ...m };
              delete next[role];
              return next;
            });
          }
          break;
        case 'delta': {
          const role = ev.role.toLowerCase();
          setLiveText((m) => ({ ...m, [role]: (m[role] ?? '') + ev.text }));
          break;
        }
        case 'review':
          setCurrent((c) => {
            if (!c) return c;
            const known = new Set(c.issues.map((i) => `${i.severity}:${i.file ?? ''}:${i.text}`));
            const fresh = ev.issues.filter((i) => !known.has(`${i.severity}:${i.file ?? ''}:${i.text}`));
            return fresh.length > 0 ? { ...c, issues: [...c.issues, ...fresh] } : c;
          });
          break;
        case 'done': {
          setCurrent((c) =>
            c ? { ...c, phase: 'DONE', siteUrl: ev.siteUrl ?? c.siteUrl, pendingQuestion: null } : c,
          );
          void refreshBuilds();
          const id = currentIdRef.current;
          if (id) void refetchCurrent(id);
          break;
        }
        case 'restored': {
          // A checkpoint restore swapped the site on disk; refetch so the
          // file list and preview reflect it.
          const rid = currentIdRef.current;
          if (rid) void refetchCurrent(rid);
          notify('info', ev.checkpoint !== undefined ? `Restored checkpoint ${ev.checkpoint}.` : 'Checkpoint restored.');
          break;
        }
        case 'error':
          setCurrent((c) => (c ? { ...c, phase: 'ERROR', error: ev.error, pendingQuestion: null } : c));
          notify('error', ev.error);
          void refreshBuilds();
          break;
      }
    },
    [notify, refreshBuilds, refetchCurrent],
  );

  const applyEventRef = useRef(applyEvent);
  useEffect(() => {
    applyEventRef.current = applyEvent;
  }, [applyEvent]);

  const currentId = current?.id ?? null;
  const running = isRunning(current?.phase);

  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  useEffect(() => {
    if (!currentId || !running) {
      setStreamStatus('idle');
      return;
    }
    const handle = openBuildEvents(currentId, (ev) => applyEventRef.current(ev), setStreamStatus);
    streamRef.current = handle;
    return () => {
      handle.close();
      if (streamRef.current === handle) streamRef.current = null;
    };
  }, [currentId, running]);

  /* ------------------------------ actions ----------------------------- */

  const sendBrief = useCallback(
    async (brief: string): Promise<boolean> => {
      loadTokenRef.current += 1;
      // A new brief wins over any in-flight history load; don't leave the
      // workspace stuck on its loading state forever.
      setBuildLoading(false);
      setSending(true);
      try {
        const { id } = await createBuild(brief, autopilot);
        setActivity({});
        setLiveText({});
        setApproved(false);
        try {
          const state = await getBuild(id);
          seedMessages(state.messages);
          setCurrent(state);
        } catch {
          // 202 means the brief was accepted; if the first fetch races the
          // store, show what we know and let the SSE replay reconcile.
          const fallback: BuildState = {
            id,
            phase: 'INTAKE',
            brief,
            messages: [{ role: 'user', text: brief }],
            files: [],
            issues: [],
          };
          seedMessages(fallback.messages);
          setCurrent(fallback);
        }
        void refreshBuilds();
        return true;
      } catch (e) {
        notify('error', errorMessage(e));
        return false;
      } finally {
        setSending(false);
      }
    },
    [notify, refreshBuilds, seedMessages, autopilot],
  );

  const answer = useCallback(
    async (text: string) => {
      const c = current;
      const q = c?.pendingQuestion;
      if (!c || !q || answering) return;
      setAnswering(true);
      try {
        await postAnswer(c.id, q.id, text);
        const echo: ChatMessage = { role: 'user', text };
        seenMessagesRef.current.add(messageKey(echo));
        setCurrent((cur) => (cur ? { ...cur, pendingQuestion: null, messages: [...cur.messages, echo] } : cur));
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          notify('info', 'That question was already resolved — refreshing.');
          await refetchCurrent(c.id);
        } else {
          notify('error', errorMessage(e));
        }
      } finally {
        setAnswering(false);
      }
    },
    [current, answering, notify, refetchCurrent],
  );

  const approve = useCallback(
    async (plan: Plan) => {
      const c = current;
      if (!c || approving) return;
      setApproving(true);
      try {
        await postApprove(c.id, plan);
        setApproved(true);
        setCurrent((cur) => (cur ? { ...cur, plan } : cur));
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          notify('info', 'That plan was already approved — refreshing.');
          await refetchCurrent(c.id);
        } else {
          notify('error', errorMessage(e));
        }
      } finally {
        setApproving(false);
      }
    },
    [current, approving, notify, refetchCurrent],
  );

  const cancel = useCallback(async () => {
    const c = current;
    if (!c || cancelling) return;
    setCancelling(true);
    try {
      await postCancel(c.id);
      await refetchCurrent(c.id);
      void refreshBuilds();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        notify('info', 'That build already finished — refreshing.');
        await refetchCurrent(c.id);
      } else {
        notify('error', errorMessage(e));
      }
    } finally {
      setCancelling(false);
    }
  }, [current, cancelling, notify, refetchCurrent, refreshBuilds]);

  const openFromHistory = useCallback(
    async (id: string) => {
      if (id === currentIdRef.current) return;
      const token = (loadTokenRef.current += 1);
      setBuildLoading(true);
      try {
        const state = await getBuild(id);
        if (loadTokenRef.current !== token) return;
        seedMessages(state.messages);
        setActivity({});
        setLiveText({});
        if (typeof state.autopilot === 'boolean') setAutopilotState(state.autopilot);
        // Only phases past planning count as approved — an INTAKE build
        // still needs its Approve button when the plan arrives.
        setApproved(['BUILDING', 'REVIEW', 'DONE'].includes(state.phase));
        setCurrent(state);
      } catch (e) {
        if (loadTokenRef.current === token) notify('error', errorMessage(e));
      } finally {
        if (loadTokenRef.current === token) setBuildLoading(false);
      }
    },
    [notify, seedMessages],
  );

  const newBuild = useCallback(() => {
    loadTokenRef.current += 1;
    setCurrent(null);
    setActivity({});
    setLiveText({});
    setApproved(false);
    setBuildLoading(false);
    setChatCollapsed(false);
    // Defer: the ref rebinds to the home composer once the view flips.
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, []);

  const openSetup = useCallback(() => {
    setSetupDismissed(false);
    setSetupOpen(true);
    setChatCollapsed(false);
  }, []);

  /** Hands-free mode: persists as the default for new builds and flips the
   *  current build's mode live (a parked build drives forward immediately). */
  const toggleAutopilot = useCallback(
    async (enabled: boolean) => {
      const prev = autopilot;
      setAutopilotState(enabled);
      try {
        window.localStorage.setItem('foundry.autopilot', enabled ? '1' : '0');
      } catch {
        /* private mode: session-only */
      }
      const id = currentIdRef.current;
      if (id === null) return;
      try {
        const s = await postAutopilot(id, enabled);
        if (currentIdRef.current === id) setCurrent(s);
      } catch (e) {
        setAutopilotState(prev);
        try {
          window.localStorage.setItem('foundry.autopilot', prev ? '1' : '0');
        } catch {
          /* ignore */
        }
        notify('error', errorMessage(e));
      }
    },
    [autopilot, notify],
  );

  const dismissSetup = useCallback(() => {
    setSetupDismissed(true);
    setSetupOpen(false);
  }, []);

  /* ------------------------------ render ------------------------------ */

  const setupNeeded =
    configError !== null ||
    (config !== null &&
      (config.provider === 'mock' ||
        // Keyless providers (ollama, mock) never need setup; hosted ones
        // need a key. The endpoint also counts for openai-compatible.
        (config.provider !== 'ollama' && !config.hasKey)));
  const showSetup = !configLoading && ((setupNeeded && !setupDismissed) || setupOpen);
  const pendingQuestion = current?.pendingQuestion ?? null;
  const plan = current?.plan ?? null;
  const currentFiles = current?.files;
  const mentionFiles = useMemo(() => (currentFiles ?? []).map((f) => f.path), [currentFiles]);

  return (
    <Layout
      mode={current !== null || buildLoading ? 'work' : 'home'}
      build={current}
      buildLoading={buildLoading}
      streamStatus={streamStatus}
      onReconnect={() => streamRef.current?.retry()}
      config={config}
      configLoading={configLoading}
      configError={configError}
      setupNeeded={setupNeeded}
      onOpenSetup={openSetup}
      builds={builds}
      buildsLoading={buildsLoading}
      buildsError={buildsError}
      onOpenBuild={(id) => void openFromHistory(id)}
      onRefreshBuilds={() => void refreshBuilds()}
      sending={sending}
      onSendBrief={sendBrief}
      composerRef={composerRef}
      chatCollapsed={chatCollapsed}
      onToggleChat={() => setChatCollapsed((c) => !c)}
      onNewBuild={newBuild}
      autopilot={autopilot}
      onToggleAutopilot={(enabled) => void toggleAutopilot(enabled)}
      setupCard={
        showSetup ? (
          <SetupCard
            config={config}
            loading={configLoading}
            error={configError}
            onSaved={() => void loadConfig()}
            onRetry={() => void loadConfig()}
            onDismiss={dismissSetup}
          />
        ) : null
      }
      chat={
        <ChatColumn
          hasBuild={current !== null || buildLoading}
          running={running}
          messages={current?.messages ?? []}
          liveText={liveText}
          sending={sending}
          onSend={sendBrief}
          mentionFiles={mentionFiles}
          canDrain={current?.phase === 'DONE'}
          onSendQueued={async (text) => {
            // Drained prompts follow up on the finished build instead of
            // silently replacing it with a new one.
            if (current?.phase === 'DONE') {
              try {
                await postEdit(current.id, text);
                return true;
              } catch {
                return false;
              }
            }
            return sendBrief(text);
          }}
          onSendNow={async (text) => {
            if (current && running) {
              try {
                await postCancel(current.id);
              } catch {
                /* already finished */
              }
            }
            return sendBrief(text);
          }}
          composerRef={composerRef}
          feedKey={`${pendingQuestion?.id ?? ''}:${plan ? 'plan' : ''}`}
        >
          {pendingQuestion && (
            <QuestionCard question={pendingQuestion} busy={answering} onAnswer={(t) => void answer(t)} />
          )}
          {plan && (
            <PlanView
              plan={plan}
              editable={!approved && current?.phase === 'PLANNED'}
              busy={approving}
              onApprove={(p) => void approve(p)}
            />
          )}
        </ChatColumn>
      }
      timeline={
        <AgentTimeline
          activity={activity}
          phase={current?.phase}
          files={current?.files ?? []}
          issues={current?.issues ?? []}
          running={running}
          cancelling={cancelling}
          onCancel={() => void cancel()}
        />
      }
      workspace={<Workspace build={current} loading={buildLoading} onNewBuild={newBuild} />}
      notice={notice}
    />
  );
}
