export const DEFAULT_INACTIVE_ICON_PATH = Object.freeze({
    16: 'img/icons/icon_19_out.png',
    19: 'img/icons/icon_19_out.png',
    32: 'img/icons/icon_19_out.png',
    48: 'img/icons/icon_19_out.png',
});

export function setInactiveActionIcon(action, iconPath = DEFAULT_INACTIVE_ICON_PATH) {
    return action.setIcon({ path: iconPath });
}

export function registerBackgroundLifecycle({
    runtime,
    action,
    storage,
    loadRadioState,
    getRadioState,
    radioPlay,
    restorePriorityBlink,
    registerWsKeepAlive,
    createContextMenus,
    ensureSilentDoctorAlarm,
    initializeAlarm,
    syncTicketQuickPollAlarm,
    foundationRunDoctor,
    syncSettingsFromStorage,
    setInactiveIcon = () => setInactiveActionIcon(action),
} = {}) {
    runtime.onInstalled.addListener(async () => {
        loadRadioState();
        registerWsKeepAlive();
        setInactiveIcon();
        createContextMenus();
        await ensureSilentDoctorAlarm();
        await initializeAlarm();
        syncTicketQuickPollAlarm();
        foundationRunDoctor(true).catch(() => {});
    });

    runtime.onStartup.addListener(async () => {
        syncSettingsFromStorage().catch(() => {});
        await loadRadioState();
        const radioState = getRadioState();
        if (radioState.enabled && radioState.isPlaying && radioState.station) {
            radioPlay();
        }
        restorePriorityBlink();
        registerWsKeepAlive();
        setInactiveIcon();
        createContextMenus();
        await storage.get(['auto_mode_active']).catch(() => ({}));
        await ensureSilentDoctorAlarm();
        await initializeAlarm();
        syncTicketQuickPollAlarm();
        foundationRunDoctor(true).catch(() => {});
    });
}
