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
| `YUKI_TEST_MANGA_DIR` | папка с мангой (тома-папки с `.mokuro`, zip-архив в `kaguya/`) | manga-smoke, manga-drag-smoke, ocr-smoke, ocr-quality |

## OCR quality gate (`tests/ocr-quality.ts`)

Гоняет production-пайплайн (`src/core/ocr/pipeline.ts`, те же параметры,
`sharp` вместо canvas) по целым томам в Node и меряет точность:

- против `.mokuro`-референса (IoU-матчинг блоков + CER), и/или
- против `tests/golden/<vol>-01.json` — vision-выверенных блоков (box =
  IoU-матчинг, box=null = текстовый матчинг по странице).

```
pnpm tsx tests/ocr-quality.ts --vol kaguya [--pages all|3,20] \
  [--models q8|merged|q4f16|fp32|l0] [--det s|full|fp16] [--dump] \
  [--gate [--gate-recall 0.85] [--gate-cer 0.10] [--gate-runaway 0]]
```

`--gate` падает с exit 1 при просадке recall / meanCER / появлении
runaway-выбросов на golden-страницах. Отчёты — в `/tmp/ocr-quality/`.
Модели читает из `/tmp/yuki-ocr-models/` (снапшот production-моделей +
fp32/l0 для A/B; `fp16` — webgpu-детектор, production-дефолт).

## Рецепт shipped-декодера

`decoder_model_merged_batch_int8.onnx` пересобирается из
`kha-white/manga-ocr-base` тремя скриптами (venv с torch/transformers/
optimum/onnxruntime): `tests/mocr-export-batch.py` (два torch.onnx.export +
merge_decoders, batch-ось динамическая везде) → `tests/mocr-quantize-batch.py`
(fold констант и weight-транспозиций в инициализеры, quantize_dynamic int8,
merge) → `tests/mocr-validate-batch.py` (доказательство: батч ≡ соло-декод
потокенно, batch=1 ≡ HF greedy; паддинг enc_seq нулями запрещён — у декодера
нет encoder attention mask).

## Регрессионные пробники скорости OCR

Оба гоняют настоящий ридер на дев-сервере (`:1420`), мангу берут из
`YUKI_TEST_MANGA_DIR`. Не редактировать `src/` во время прогона — vite
full-reload рвёт загрузку моделей.

- `pnpm tsx tests/gate-timing.ts` — холодный старт тома: загрузка моделей,
  detect-гейт, первые страницы. Ориентир: гейт < 30 с.
- `pnpm tsx tests/march-timing.ts [секунды]` — непрерывный марш по страницам,
  страниц/минуту и пер-стейдж тайминги из `[ocr-page]`-логов. Ориентир:
  ≥ 100 стр/мин.

Ожидания `pdf-smoke` (число страниц, язык) завязаны на конкретные фикстуры —
при смене файла поправить проверки в коде. `layout-smoke` и `position-smoke`
принимают папку с книгами и первым аргументом командной строки.
