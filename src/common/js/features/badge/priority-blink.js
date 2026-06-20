export function createPriorityBlinkService({
    storage,
    alarms,
    alarmName,
    setBlinkBadge,
    updateAction,
    loadState = () => storage.get(['priority_blinking', 'focused_topics']),
} = {}) {
    let phase = false;
    let blinking = false;

    function applyBlinkPhase() {
        if (!blinking) return false;
        phase = !phase;
        setBlinkBadge(phase);
        return true;
    }

    async function start() {
        if (blinking) return false;
        blinking = true;
        phase = false;
        await storage.set({ priority_blinking: true });
        applyBlinkPhase();
        alarms.create(alarmName, { periodInMinutes: 1 });
        return true;
    }

    function stop() {
        blinking = false;
        alarms.clear(alarmName).catch(() => {});
        storage.set({ priority_blinking: false }).catch(() => {});
        setBlinkBadge(false);
        updateAction();
    }

    async function restoreIfNeeded() {
        try {
            const state = await loadState();
            if (!state.priority_blinking) return false;
            const focusedTopics = (state.focused_topics || []).map(String);
            if (!focusedTopics.length) {
                storage.set({ priority_blinking: false }).catch(() => {});
                return false;
            }
            blinking = true;
            applyBlinkPhase();
            alarms.create(alarmName, { periodInMinutes: 1 });
            return true;
        } catch (_) {
            return false;
        }
    }

    function isBlinking() {
        return blinking;
    }

    return {
        start,
        stop,
        restoreIfNeeded,
        applyBlinkPhase,
        isBlinking,
    };
}
