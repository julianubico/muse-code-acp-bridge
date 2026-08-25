import {
  CHILD_KILL_WAIT_MS,
  CHILD_TERM_GRACE_MS,
} from "./config.mjs";

export function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      resolve(value);
    };
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

export async function terminateChild(child) {
  if (childHasExited(child)) {
    return;
  }

  killChild(child, "SIGTERM");
  if (await waitForChildExit(child, CHILD_TERM_GRACE_MS)) {
    return;
  }

  killChild(child, "SIGKILL");
  await waitForChildExit(child, CHILD_KILL_WAIT_MS);
}

export async function cancelSession(session) {
  session.cancelled = true;
  for (const task of session.pendingTasks) {
    task.cancelled = true;
  }

  const child = session.child;
  if (child && !childHasExited(child)) {
    if (!session.childTermination) {
      session.childTermination = terminateChild(child).finally(() => {
        session.childTermination = null;
      });
    }
    await session.childTermination;
  }
}

export function killChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group has already exited.
    }
  }
  child.kill(signal);
}
