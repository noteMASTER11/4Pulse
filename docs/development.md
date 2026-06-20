# Разработка 4Pulse

## Первый запуск

```bash
npm install
npm run setup:browser
```

Вторая команда устанавливает отдельный Chromium for Testing. Он нужен потому,
что обычные Chrome и Edge ограничивают автоматическую загрузку распакованных
расширений.

## Быстрый просмотр интерфейса

```bash
npm run dev
```

Команда собирает Chromium-версию, запускает браузер с изолированным профилем
`.dev/chromium-profile` и открывает popup как обычную вкладку.

Доступны дополнительные цели:

```bash
npm run dev:sidebar
npm run dev:options
npm run dev:all
```

Профиль сохраняется между запусками, поэтому настройки и тестовая авторизация
не теряются. Он не затрагивает основной профиль Chrome.

Если нужен конкретный Chromium-браузер, задайте полный путь через
`CHROMIUM_PATH`. Для PowerShell:

```powershell
$env:CHROMIUM_PATH = 'C:\path\to\chromium.exe'
npm run dev
```

## Проверки

```bash
npm run lint
npm test
npm run test:watch
npm run check
```

`check` последовательно запускает ESLint, unit-тесты и обе сборки. Та же команда
выполняется в GitHub Actions для каждого pull request.

