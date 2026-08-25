export function createSessionManager({
  normalizeCwd,
  cancelSession,
  runPrompt,
  maxQueuedPrompts,
}) {
  const sessions = new Map();

  function sessionFor(id, params = {}) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("ACP sessionId is required");
    }
    const existing = sessions.get(id);
    if (existing) {
      if (params.cwd !== undefined) {
        const requestedCwd = normalizeCwd(params.cwd);
        if (requestedCwd !== existing.cwd) {
          throw new Error(
            `ACP session ${id} is bound to ${existing.cwd}; refusing cwd ${requestedCwd}`,
          );
        }
      }
      return existing;
    }

    const session = {
      id,
      cwd: normalizeCwd(params.cwd),
      child: null,
      cancelled: false,
      toolSequence: 0,
      promptTail: Promise.resolve(),
      queuedPrompts: 0,
      pendingTasks: new Set(),
      activeTask: null,
      childTermination: null,
      closed: false,
    };
    sessions.set(id, session);
    return session;
  }

  function requireSession(id) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("ACP sessionId is required");
    }
    const session = sessions.get(id);
    if (!session) {
      throw new Error(`Unknown ACP session ${id}`);
    }
    return session;
  }

  function queuePrompt(session, prompt) {
    if (session.closed) {
      throw new Error(`Muse session ${session.id} is closed`);
    }
    if (session.queuedPrompts >= maxQueuedPrompts) {
      throw new Error(
        `Muse session ${session.id} has too many queued prompts ` +
          `(${maxQueuedPrompts})`,
      );
    }

    const waitForPrevious = session.promptTail.catch(() => {});
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    session.promptTail = waitForPrevious.then(() => gate);
    session.queuedPrompts += 1;
    const task = { cancelled: false };
    session.pendingTasks.add(task);

    return waitForPrevious.then(async () => {
      try {
        if (session.closed || task.cancelled) {
          return { stopReason: "cancelled" };
        }
        task.active = true;
        session.activeTask = task;
        return await runPrompt(session, prompt);
      } finally {
        task.active = false;
        session.pendingTasks.delete(task);
        if (session.activeTask === task) {
          session.activeTask = null;
        }
        session.queuedPrompts -= 1;
        release();
      }
    });
  }

  async function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    session.closed = true;
    await cancelSession(session);
    await session.promptTail.catch(() => {});
    sessions.delete(id);
  }

  async function deleteSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    await cancelSession(session);
    await session.promptTail.catch(() => {});
    sessions.delete(id);
  }

  async function cancel(id) {
    const session = sessions.get(id);
    if (session) {
      await cancelSession(session);
    }
  }

  function all() {
    return [...sessions.values()];
  }

  function list() {
    return all().map((session) => ({
      sessionId: session.id,
      cwd: session.cwd,
      title: "Muse Code session",
    }));
  }

  return {
    all,
    cancel,
    closeSession,
    deleteSession,
    list,
    queuePrompt,
    requireSession,
    sessionFor,
  };
}
