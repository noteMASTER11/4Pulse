# 4Pulse

Расширение для форума 4PDA с поддержкой Firefox и Chromium-браузеров.

## Возможности

- уведомления о новых сообщениях, темах и упоминаниях;
- QMS, избранное, тикеты и навигация;
- встроенное радио;
- светлая и тёмная темы;
- профили интерфейса;
- настройка плиток, внешнего вида и поведения;
- отдельные сборки для Firefox и Chrome / Edge.

## Структура проекта

- `src/common` — общий код для Firefox и Chrome;
- `src/firefox` — Firefox manifest и background;
- `src/chrome` — Chrome manifest, service worker, offscreen и сетевые правила;
- `scripts/build.mjs` — сборочный скрипт;
- `dist/firefox` — готовая Firefox-сборка;
- `dist/chrome` — готовая Chrome-сборка.

## Сборка

Обе версии:

```bash
npm run build
```

Только Firefox:

```bash
npm run build:firefox
```

Только Chrome:

```bash
npm run build:chrome
```

## Установка для тестирования

### Firefox

1. Собрать Firefox-версию:

```bash
npm run build:firefox
```

2. Открыть в Firefox:

```text
about:debugging
```

3. Выбрать **This Firefox**.
4. Нажать **Load Temporary Add-on**.
5. Выбрать файл:

```text
dist/firefox/manifest.json
```

### Chrome / Edge

1. Собрать Chromium-версию:

```bash
npm run build:chrome
```

2. Открыть:

```text
chrome://extensions
```

или:

```text
edge://extensions
```

3. Включить режим разработчика.
4. Нажать **Load unpacked**.
5. Выбрать папку:

```text
dist/chrome
```

## Готовые пакеты

Готовые версии для установки публикуются в разделе **Releases**:

- Firefox — `.xpi`;
- Chrome / Edge — `.zip`.

## Текущая версия

`1.9.1`

## Разработка

Проверить код и обе сборки:

```bash
npm install
npm run check
```

Запустить Chromium с загруженным расширением и сразу открыть popup:

```bash
npm run setup:browser
npm run dev
```

Подробности: [`docs/development.md`](docs/development.md). План модульной
архитектуры: [`docs/architecture.md`](docs/architecture.md).
