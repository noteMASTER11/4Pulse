export function stripHtmlText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function buildSmartInsights(snapshot) {
  const insights = [];
  const counts = snapshot.counts || {};
  const health = snapshot.health || {};
  const bookmarks = snapshot.bookmarks || {};
  const radio = snapshot.radio || {};
  const total = (
    (counts.qms || 0) +
    (counts.favorites || 0) +
    (counts.mentions || 0) +
    (counts.tickets || 0)
  );

  if (!snapshot.authorized) insights.push({ level: 'danger', title: 'Нет входа на 4PDA', text: 'Расширение не сможет получить QMS, избранное, тикеты и закладки, пока cookie авторизации недоступны.', action: 'Открой 4PDA и войди в аккаунт.', target: 'auth' });
  if (!snapshot.wsConnected) insights.push({ level: 'warning', title: 'WebSocket offline', text: 'Realtime-события могут приходить с задержкой. Расширение будет опираться на polling.', action: 'Нажми «Починить 4Pulse» или перезапусти расширение.' });
  if (health.polling && !health.polling.exists) insights.push({ level: 'danger', title: 'Polling alarm не найден', text: 'Фоновая проверка может не запускаться автоматически.', action: 'Нажми «Починить 4Pulse» — alarm будет создан заново.' });
  if (health.polling?.is429Active) insights.push({ level: 'warning', title: 'Активна защита 429', text: '4PDA недавно ограничивал частоту запросов. Расширение специально замедляет проверки.', action: 'Не ставь слишком маленький интервал обновления.' });
  if (bookmarks.enabled && !bookmarks.loaded) insights.push({ level: 'warning', title: 'Закладки не загружены', text: 'Вкладка закладок включена, но в памяти расширения сейчас нет данных.', action: 'Запусти принудительное обновление или проверь WebSocket.' });
  if (snapshot.settings?.tickets_enabled && counts.tickets > 0) insights.push({ level: 'hot', title: 'Есть тикеты', text: `Найдено тикетов: ${counts.tickets}.`, action: 'Открой раздел тикетов.', target: 'tickets' });
  if (counts.qms > 0) insights.push({ level: 'info', title: 'Есть новые QMS', text: `Новых диалогов/сообщений: ${counts.qms}.`, action: 'Проверь личные сообщения.', target: 'qms' });
  if (total === 0 && snapshot.authorized && snapshot.wsConnected && !health.issues?.length) insights.push({ level: 'ok', title: 'Всё спокойно', text: 'Критичных событий нет, авторизация и WebSocket выглядят нормально.', action: 'Можно оставить расширение работать в фоне.' });
  if (radio.enabled && radio.lastError) insights.push({ level: 'warning', title: 'Ошибка радио', text: radio.lastError, action: 'Смени станцию или перезапусти радио.', target: 'radio' });

  return insights.slice(0, 8);
}

export function buildAttentionCenter(data) {
  const tasks = [];
  const favorites = Array.isArray(data?.favorites?.list) ? data.favorites.list : [];
  const qms = Array.isArray(data?.qms?.list) ? data.qms.list : [];
  const mentions = Array.isArray(data?.mentions?.list) ? data.mentions.list : [];

  qms.filter(dialog => (
    (dialog.unread || dialog.count || dialog.new_count) && !dialog.viewed
  )).slice(0, 4).forEach(dialog => {
    tasks.push({
      type: 'qms',
      priority: 80,
      id: dialog.id,
      dialog_id: dialog.id,
      opponent_id: dialog.opponent_id || dialog.mid,
      title: stripHtmlText(dialog.title || dialog.name || dialog.username || 'Новое QMS'),
      meta: stripHtmlText(dialog.last_message || dialog.text || 'Личное сообщение'),
      actions: ['open_qms'],
    });
  });

  mentions.filter(mention => (
    mention.unread || !mention.viewed
  )).slice(0, 4).forEach(mention => {
    tasks.push({
      type: 'mention',
      priority: 70,
      id: mention.id,
      topic_id: mention.topic_id,
      post_id: mention.post_id,
      title: stripHtmlText(mention.title || mention.topic_title || 'Упоминание'),
      meta: stripHtmlText(mention.author || mention.section || 'Ответ/упоминание'),
      actions: ['open_mention'],
    });
  });

  favorites.filter(topic => !topic.viewed).slice(0, 8).forEach(topic => {
    const unread = Number(topic.unread_count || topic.count || 1);
    const priority = (topic.focused ? 68 : 45) + Math.min(20, unread) + (topic.pin ? 6 : 0);
    tasks.push({
      type: 'favorite',
      priority,
      id: topic.id,
      title: stripHtmlText(topic.title || 'Избранная тема'),
      meta: unread > 1 ? `Новых сообщений: ${unread}` : 'Есть новое сообщение',
      unread,
      actions: ['open_favorite', 'mute_topic'],
    });
  });

  tasks.sort((left, right) => right.priority - left.priority);
  return {
    ts: Date.now(),
    total: tasks.length,
    critical: 0,
    headline: tasks.length ? 'Есть события для реакции' : 'Сейчас всё спокойно',
    tasks: tasks.slice(0, 12),
  };
}

export function buildMorningDigest(data) {
  const counts = {
    tickets: data?.tickets?.enabled ? (data.tickets.count || 0) : 0,
    qms: data?.qms?.count || 0,
    mentions: data?.mentions?.count || 0,
    favorites: data?.favorites?.count || 0,
    bookmarks: Array.isArray(data?.bookmarks?.list)
      ? data.bookmarks.list.filter(bookmark => !bookmark.deleted).length
      : 0,
  };
  const total = counts.tickets + counts.qms + counts.mentions + counts.favorites;
  return {
    ts: Date.now(),
    counts,
    total,
    title: total ? 'Утренний дайджест готов' : 'Дайджест: новых событий нет',
    text: total
      ? `${counts.tickets ? `Тикеты: ${counts.tickets}, ` : ''}QMS: ${counts.qms}, ответы: ${counts.mentions}, темы: ${counts.favorites}.`
      : `Новых QMS, ответов и тем сейчас нет. Закладок в памяти: ${counts.bookmarks}.`,
  };
}

export function buildFavoritesCleanup(data, now = Date.now()) {
  const favorites = Array.isArray(data?.favorites?.list) ? data.favorites.list : [];
  const nowSeconds = Math.floor(now / 1000);
  const suggestions = [];

  favorites.forEach(topic => {
    const ageDays = topic.last_post_ts
      ? Math.round((nowSeconds - Number(topic.last_post_ts)) / 86400)
      : null;
    const unread = Number(topic.unread_count || topic.count || 0);
    if (unread >= 15) {
      suggestions.push({
        type: 'noisy', id: topic.id, title: stripHtmlText(topic.title),
        reason: `Много новых сообщений: ${unread}`, action: 'mute_week',
      });
    } else if (ageDays !== null && ageDays >= 45 && topic.viewed) {
      suggestions.push({
        type: 'stale', id: topic.id, title: stripHtmlText(topic.title),
        reason: `Нет активности примерно ${ageDays} дн.`, action: 'review',
      });
    }
  });

  return { total: suggestions.length, suggestions: suggestions.slice(0, 8) };
}

