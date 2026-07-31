# Тесты

Юниты и парсерные смоуки (`pnpm test`, `shelf-unit`, `stats-unit`,
`book-css-smoke`, `resources-smoke`, `epub-smoke`) самодостаточны — фикстуры
собираются на лету.

Браузерные смоуки гоняют настоящий ридер на настоящих книгах, а книги —
приватные файлы, в репозитории их нет. Пути передаются переменными
окружения:

| Переменная | На что указывает | Кто использует |
| --- | --- | --- |
| `YUKI_TEST_EPUB_DIR` | папка с тестовыми `.epub` | все epub-смоуки |
| `YUKI_TEST_EPUB_FILTER` | подстрока имени основной книги (её же ищет поиск) | stats, routing, bookmark, reader-panel, library |
| `YUKI_TEST_EPUB_FILTER2` | подстрока имени второй книги | library |
| `YUKI_TEST_PDF_TEXT` | книжный PDF с текстовым слоем | pdf-smoke, reader-panel, perf-probe, pdf-probe |
| `YUKI_TEST_PDF_SCAN` | PDF со сканированными страницами | pdf-smoke, perf-probe, pdf-probe |
| `YUKI_TEST_MANGA_DIR` | папка с мангой (тома-папки с `.mokuro`, zip-архив в `kaguya/`) | manga-smoke |

Ожидания `pdf-smoke` (число страниц, язык) завязаны на конкретные фикстуры —
при смене файла поправить проверки в коде. `layout-smoke` и `position-smoke`
принимают папку с книгами и первым аргументом командной строки.
