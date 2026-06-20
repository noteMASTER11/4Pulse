# Архитектура

Проект постепенно переходит от крупных платформенных файлов к feature-based
модулям. Новая логика не должна добавляться непосредственно в
`chrome/background.js`, `firefox/background.js` или готовые `*.release.js`.

Целевая структура общей части:

```text
src/common/js/
├── config/               общая конфигурация и runtime-настройки
├── core/                 запуск приложения, события и инфраструктура
├── features/
│   └── <feature>/        модель, парсеры и use cases одной функции
├── platform/             адаптеры WebExtension API
└── ui/                   исходные модули popup/sidebar/options
```

Сделанный первый срез:

- состояние настроек вынесено в `config/settings.js`;
- сущности больше не импортируют центральный класс `CS`, циклическая зависимость
  удалена;
- общий разбор ссылок предпросмотра избранного вынесен из двух background-файлов
  в `features/favorites/preview-links.js` и покрыт тестами.
- нормализация потоков и сопоставление станций вынесены в
  `features/radio/metadata.js`;
- диагностические подсказки, центр внимания, дайджест и очистка избранного
  находятся в `features/diagnostics/insights.js`.
- `core/messages/router.js` задаёт единый асинхронный контракт runtime-команд;
- radio- и foundation/diagnostics-команды вынесены из глобального `onMessage` в
  feature-роутеры с явными зависимостями;
- профильные пресеты и backup-ключи находятся в
  `features/foundation/profiles.js` и не зависят от WebExtension API.
- bookmark-команды представлены тонким адаптером
  `features/bookmarks/messages.js` поверх методов `CS`;
- ticket-команды, Windows-1251 form encoding и разбор страницы тикета вынесены
  в `features/tickets`, сохраняя прежние fallback-ответы для UI.
- нормализация захваченного каталога смайлов изолирована в `features/smileys`;
- fallback-цепочка обновления аватара оформлена как `features/avatar`;
- правила открытия popup/sidebar/background-вкладок и переходы к сущностям
  находятся в `features/navigation/messages.js`.
- lifecycle popup, ожидание инициализации service worker, reload runtime-настроек,
  read-state и совместимые форматы счётчиков находятся в
  `features/popup/messages.js`.
- QMS subject, credentialed HTML-fetch, предпросмотр избранного и debug-доступ к
  открытой вкладке форума находятся в `features/content/messages.js`;
- глобальный `runtime.onMessage` больше не содержит бизнес-`switch`: background
  отвечает только за композицию feature-роутеров и платформенных зависимостей.
- long-lived port-команды массового чтения/открытия тем находятся в
  `features/favorites/ports.js`;
- локализация, построение и click-dispatch context menu находятся в
  `features/context-menu/service.js`;
- имена alarm-событий, polling/backoff schedule и alarm dispatch сосредоточены в
  `features/alarms/service.js`; платформы инжектируют только radio keepalive.
- radio cookie/CORS guard вынесен в `features/radio/cookie-guard.js`; Chrome MV3 может полагаться на
  declarativeNetRequest-правила, а Firefox использует общий webRequest-guard.
- health/event log и глобальные JS error handlers вынесены в `features/diagnostics/event-log.js` и
  `features/diagnostics/error-handlers.js`; background больше не хранит буфер логов вручную.
- diagnostics snapshot, storage/alarm integrity и popup health envelope находятся в
  `features/diagnostics/snapshot.js`, поэтому background отвечает только за передачу runtime-зависимостей.
- lookup/cache аватаров авторов, извлечение аватара из HTML профиля и fallback для открытых вкладок находятся в
  `features/avatar/service.js`; message-router получает готовые use cases через dependency injection.
- priority blink state machine находится в `features/badge/priority-blink.js`; background больше не хранит phase/state
  мигания и только передаёт `setBlinkBadge`/`update_action`.
- install/startup bootstrap, восстановление radio/blink state и первичная inactive-иконка вынесены в
  `features/lifecycle/bootstrap.js`.

Следующий крупный этап — восстановить редактируемые исходники UI вместо
минифицированных `*.release.js`, после чего разделить popup/sidebar/options на
компоненты и собирать release-файлы автоматически.
