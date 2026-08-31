function blocked(code, message) {
  return Object.assign(new Error(message), { status: 409, code });
}

function requireIdle(scheduler) {
  if (!Number.isInteger(scheduler?.activeTurns) || scheduler.activeTurns < 0) {
    throw blocked(
      "RELAY_STATE_UNKNOWN",
      "Cannot verify Relay's active work; restart was not attempted",
    );
  }
  if (scheduler.activeTurns > 0) {
    throw blocked(
      "RELAY_BUSY",
      `Relay has ${scheduler.activeTurns} active business turns; restart is deferred without interrupting them`,
    );
  }
}

// Pause only an already-idle scheduler, then check the atomic pause response to
// close the health-check/dispatch race. A failed attempt restores our own pause.
export async function acquireRelayIdleWindow({
  probe,
  setPaused,
  allowUnavailable = false,
}) {
  const health = await probe();
  if (!health.ok) {
    if (!allowUnavailable) {
      throw blocked(
        "RELAY_STATE_UNAVAILABLE",
        "Relay health is unavailable; wait for confirmed health recovery instead of interrupting unknown work",
      );
    }
    // Only the repeated-health-failure recovery path may bypass live state.
    return async () => {};
  }
  requireIdle(health.body?.scheduler);
  if (health.body.scheduler.paused === true) return async () => {};
  let released = false;
  const release = async ({ restarted = false } = {}) => {
    if (released) return;
    if (!restarted) await setPaused(false);
    released = true;
  };
  try {
    const paused = await setPaused(true);
    if (paused?.scheduler?.paused !== true) {
      throw blocked(
        "RELAY_PAUSE_UNCONFIRMED",
        "Relay did not confirm the idle restart window",
      );
    }
    requireIdle(paused.scheduler);
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
