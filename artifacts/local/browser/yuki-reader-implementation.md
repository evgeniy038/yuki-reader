# Yuki reader: implementation handoff

Дата: 2026-08-02. Реализовано в v1.2.5. Проверены EPUB, PDF и ZIP-манга на живом локальном приложении.

## Решения и пользовательские пути

### 1. Manga: клик по всей свободной области

Hitbox теперь не ограничен фиксированными 50 или 100 px. Используется реальный `page-set`: весь участок от левого края viewport до левой границы видимых страниц листает вперёд, весь участок справа листает назад. Это масштабируется вместе с zoom и не требует угадывать ширину зоны.

Путь: навести курсор в свободную область → увидеть `cursor-pointer` → один клик. Клик внутри page-set, OCR-текста или по индикатору страницу не меняет. Wheel остался zoom, потому что совмещение wheel paging и zoom ломало бы управление.

![Manga spread and jump](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/artifacts/local/browser/screenshots/10-implemented-manga-spread.png)

### 2. Manga: единый холст

Убран CSS gutter между двумя page-boxes. Самостоятельные page-boxes оставлены: на них завязаны OCR-координаты и selectable OCR-текст.

Путь: открыть спред → две страницы сразу выглядят как одно полотно; дополнительных действий нет.

### 3. Manga: first page as cover

Переключатель находится в Settings только manga-ридера. Значение глобальное и сохраняется в `yuki:reading`, default включён, старые настройки безопасно получают `true`.

- Включено: `1`, затем `[2,3]`, `[4,5]`.
- Выключено: `[1,2]`, `[3,4]`, `[5,6]`.

Путь: открыть handle/верхнее меню → Settings → переключить `First page as cover`. Режим меняется сразу, без Save, потому что настройка влияет только на раскладку текущего ридера.

![Manga cover setting](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/artifacts/local/browser/screenshots/11-implemented-manga-settings.png)

### 4. EPUB: шрифт без верхнего предела

Существующий Stepper сохранён, но верхняя граница убрана. Остаётся только нижний предел 14 px и защита от нечисловых значений. В живом ридере проверено 38 px, кнопка `+` продолжает работать.

Путь: Settings → Size → нажимать `+` столько, сколько нужно. Шрифт не упирается в 24 px.

![EPUB uncapped font](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/artifacts/local/browser/screenshots/13-implemented-epub-font-controls.png)

### 5. Прыжок к позиции

Пассивный position chip стал кнопкой, потому что это самый короткий путь: не прятать часто используемую навигацию в Settings.

- EPUB: ввод `0–100%`; значение переводится в глобальный character anchor, поэтому resize и изменение шрифта не ломают смысл позиции.
- Manga: ввод физической страницы; переход нормализуется к началу актуального spread.

Путь: один клик по индикатору → ввести значение → Enter или Go. В живом EPUB проверен переход на 50%; в manga проверен переход на страницу 10 с нормализацией к spread.

![EPUB jump](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/artifacts/local/browser/screenshots/12-implemented-epub-jump.png)

### 6. Верхнее меню

Auto-hide сохранён, но в скрытом состоянии всегда остаётся маленький верхний handle с aria-label `Show reader controls`. Activation band расширен до 64 px. Это даёт очевидную точку входа, не занимая постоянное место полноценной панелью.

Путь: hover или click по handle → верхняя панель → Back, Settings, Contents, Search или Fullscreen.

### 7. Escape

В `ReaderScreen` добавлен единый приоритет: сначала закрыть Settings, затем TOC/Search, затем выйти из EPUB или manga. PDF намеренно оставлен без выхода по Escape, так как запрос касался новеллы и manga.

Путь: чистый EPUB/manga reader → `Escape` → shelf/series page. При открытом transient UI первый Escape закрывает UI, второй выходит.

### 8. Manga: zoom-out и pan

Минимальный zoom стал `1/3`, максимум оставлен `5`. Drag разрешён при любом масштабе, кроме ровно `1`, без искусственных bounds и snap-to-center. OCR guard, drag threshold и подавление click после pan сохранены.

Путь: wheel вниз до нужного масштаба → drag в любую сторону → click edge для page turn. Живой smoke проверил pan на `0.333x`.

## Куда положено

- Общий click/wheel/key routing: [`use-paging-input.ts`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/components/reader/use-paging-input.ts).
- Manga hitbox, spread layout, cover math and page jump: [`manga-reading-view.tsx`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/components/reader/manga-reading-view.tsx).
- EPUB-safe edge click and percent jump: [`reading-view.tsx`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/components/reader/reading-view.tsx).
- Shared jump UI: [`page-indicator.tsx`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/components/reader/page-indicator.tsx).
- Cover persistence and uncapped font validation: [`reading-settings.ts`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/core/reading-settings.ts).
- Settings ownership, Escape priority and format gates: [`reader-screen.tsx`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/components/reader/reader-screen.tsx).
- Reader discoverability and Settings entry: [`reader-chrome.tsx`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/components/reader/reader-chrome.tsx) and [`reader-settings-popover.tsx`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/components/reader/reader-settings-popover.tsx).
- Zoom floor and pan behavior: [`use-zoom-pan.ts`](/Users/evegnius/Desktop/work_hobbies/projects/personal/apps/yuki/src/components/reader/use-zoom-pan.ts).

## Проверки

- `pnpm typecheck`: PASS.
- `pnpm build`: PASS; только существующее предупреждение о крупных чанках.
- `pnpm test:epub`: PASS.
- `pnpm test:position '/Users/evegnius/Desktop/work_hobbies/言語学習者/novels' '_OceanofPDF.com_コンビニ人間'`: PASS.
- `YUKI_TEST_MANGA_DIR='/Users/evegnius/Desktop/work_hobbies/言語学習者/manga' pnpm tsx tests/manga-drag-smoke.ts`: PASS.
- Живой браузер: cover switch, manga full-margin hitbox, no-gap spread, manga/EPUB jump, EPUB text-selection safety, Escape, uncapped font, zoom-out/pan, PDF regression.

В консоли браузера остаются известные фоновые OCR warnings и blob URL ошибки от текущего OCR-пайплайна; они воспроизводились до изменений и не блокируют reader smoke.
