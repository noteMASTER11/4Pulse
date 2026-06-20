const MENU_I18N = {
  ru: { update: '4Pulse: обновить всё', qms: 'Открыть QMS', fav: 'Открыть избранное', mentions: 'Открыть упоминания', tickets: 'Открыть тикеты', site: 'Открыть 4PDA', auth: 'Авторизация / вход на 4PDA', profile: 'Мой профиль на 4PDA', options: 'Настройки 4Pulse', diagnostics: 'Диагностика 4Pulse' },
  en: { update: '4Pulse: refresh everything', qms: 'Open QMS', fav: 'Open Favorites', mentions: 'Open Mentions', tickets: 'Open Tickets', site: 'Open 4PDA', auth: 'Authorization / sign in to 4PDA', profile: 'My 4PDA profile', options: '4Pulse settings', diagnostics: '4Pulse diagnostics' },
  de: { update: '4Pulse: alles aktualisieren', qms: 'QMS öffnen', fav: 'Favoriten öffnen', mentions: 'Erwähnungen öffnen', tickets: 'Tickets öffnen', site: '4PDA öffnen', auth: 'Autorisierung / Anmeldung bei 4PDA', profile: 'Mein 4PDA-Profil', options: '4Pulse-Einstellungen', diagnostics: '4Pulse-Diagnose' },
  uk: { update: '4Pulse: оновити все', qms: 'Відкрити QMS', fav: 'Відкрити обране', mentions: 'Відкрити згадки', tickets: 'Відкрити тікети', site: 'Відкрити 4PDA', auth: 'Авторизація / вхід на 4PDA', profile: 'Мій профіль на 4PDA', options: 'Налаштування 4Pulse', diagnostics: 'Діагностика 4Pulse' },
};

export function buildContextMenuItems({ language = 'ru', showTickets = false, updateIcons = false } = {}) {
  const labels = MENU_I18N[language] || MENU_I18N.ru;
  const base = { contexts: ['action'] };
  return [
    { ...base, id: 'update.all', title: labels.update, ...(updateIcons ? { icons: { 16: 'img/icons/icon_48.png', 32: 'img/icons/icon_48.png' } } : {}) },
    { ...base, id: 'open.qms', title: labels.qms },
    { ...base, id: 'open.favorites', title: labels.fav },
    { ...base, id: 'open.mentions', title: labels.mentions },
    ...(showTickets ? [{ ...base, id: 'open.tickets', title: labels.tickets }] : []),
    { ...base, id: 'sep.auth', type: 'separator' },
    { ...base, id: 'open.site', title: labels.site },
    { ...base, id: 'open.auth', title: labels.auth },
    { ...base, id: 'open.profile', title: labels.profile },
    { ...base, id: 'sep.settings', type: 'separator' },
    { ...base, id: 'open.options', title: labels.options },
    { ...base, id: 'open.diagnostics', title: labels.diagnostics },
  ];
}

export function createContextMenuService({
  api,
  loadState,
  updateIcons = false,
  actions,
  onError,
}) {
  return {
    async refresh() {
      if (!api) return;
      try {
        const state = await loadState();
        const items = buildContextMenuItems({
          language: state.ui_language || 'ru',
          showTickets: Boolean(state.tickets_unlocked && state.tickets_enabled),
          updateIcons,
        });
        await new Promise(resolve => {
          api.removeAll(() => {
            items.forEach(item => api.create(item));
            resolve();
          });
        });
      } catch (error) {
        onError?.(error);
      }
    },
    handleClick(menuItemId) {
      const action = actions[menuItemId];
      if (!action) return false;
      Promise.resolve().then(action).catch(onError);
      return true;
    },
  };
}

