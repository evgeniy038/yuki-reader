import { useEffect, useState } from "react";
import { Book } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Stepper } from "@/components/ui/stepper";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ProgressRing } from "@/components/ui/progress-ring";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GOAL_CHARS_MAX,
  GOAL_CHARS_MIN,
  GOAL_CHARS_STEP,
  GOAL_PERCENT_MAX,
  GOAL_PERCENT_MIN,
  GOAL_PERCENT_STEP,
  goalTarget,
  loadDailyGoal,
  saveDailyGoal,
  type GoalMode,
} from "@/core/stats";
import { formatNumber } from "@/lib/format";
import type { GoalBook } from "./use-goal-book";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./settings-group";

/** Shelf option for the goal book picker. */
export interface GoalBookOption {
  id: string;
  title: string;
  cover?: string;
}

const GOAL_MODES: { value: GoalMode }[] = [
  { value: "chars" },
  { value: "percent" },
];

/** Cover thumb + title — shared by the picker items and the trigger label. */
function BookOptionView({ option }: { option: GoalBookOption }) {
  return (
    <>
      {option.cover ? (
        <img
          src={option.cover}
          alt=""
          className="size-5 shrink-0 rounded-sm object-cover"
        />
      ) : (
        <span className="grid size-5 shrink-0 place-items-center rounded-sm bg-muted">
          <Book className="size-3 text-muted-content" />
        </span>
      )}
      <span className="line-clamp-1">{option.title}</span>
    </>
  );
}

// The daily goal: a flat char count ("3,000 characters a day") or a percent
// of a book's volume ("8% of …" — the user picks the book with the cover
// picker; for a PDF the percent applies to its pages). The goal persists;
// the bookId is pushed up so the app resolves the book's volume.
export function GoalSection({
  todayChars,
  todayPages,
  goalBook,
  goalBookOptions,
  onGoalBookChange,
}: {
  todayChars: number;
  todayPages: number;
  goalBook?: GoalBook;
  goalBookOptions: GoalBookOption[];
  onGoalBookChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState(() => loadDailyGoal());

  // Push the persisted goal book up, so the app resolves its volume.
  useEffect(() => {
    if (goal.bookId) onGoalBookChange(goal.bookId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chars mode counts chars; percent mode counts the current book's unit —
  // chars for EPUB, pages for PDF.
  const bookVolume =
    goalBook === undefined
      ? null
      : goalBook.totalChars > 0
        ? goalBook.totalChars
        : goalBook.totalPages > 0
          ? goalBook.totalPages
          : null;
  const bookIsPages =
    goalBook !== undefined && goalBook.totalChars === 0;
  const target = goalTarget(goal, bookVolume);
  const done =
    goal.mode === "chars"
      ? todayChars
      : bookIsPages
        ? todayPages
        : todayChars;
  const goalPct = target ? Math.round(Math.min(1, done / target) * 100) : 0;

  const update = (next: typeof goal) => {
    setGoal(next);
    saveDailyGoal(next);
  };
  const stepGoal = (delta: 1 | -1) => {
    update(
      goal.mode === "chars"
        ? {
            ...goal,
            chars: Math.min(
              GOAL_CHARS_MAX,
              Math.max(GOAL_CHARS_MIN, goal.chars + delta * GOAL_CHARS_STEP),
            ),
          }
        : {
            ...goal,
            percent: Math.min(
              GOAL_PERCENT_MAX,
              Math.max(
                GOAL_PERCENT_MIN,
                goal.percent + delta * GOAL_PERCENT_STEP,
              ),
            ),
          },
    );
  };

  return (
    <SettingsGroup title={t("stats.goal.title")}>
      <SettingsRow label={t("stats.goal.mode")}>
        <SegmentedControl
          segments={GOAL_MODES.map((mode) => ({
            value: mode.value,
            label:
              mode.value === "chars"
                ? t("stats.goal.chars")
                : t("stats.goal.percent"),
          }))}
          value={goal.mode}
          onChange={(mode) => update({ ...goal, mode })}
          ariaLabel={t("stats.goal.modeAria")}
        />
      </SettingsRow>
      <SettingsRow
        label={
          goal.mode === "chars"
            ? t("stats.goal.charsPerDay")
            : t("stats.goal.bookPerDay")
        }
      >
        <Stepper
          value={goal.mode === "chars" ? goal.chars : goal.percent}
          display={
            goal.mode === "chars"
              ? formatNumber(goal.chars)
              : `${goal.percent} %`
          }
          onStep={stepGoal}
          canDecrement={
            goal.mode === "chars"
              ? goal.chars > GOAL_CHARS_MIN
              : goal.percent > GOAL_PERCENT_MIN
          }
          canIncrement={
            goal.mode === "chars"
              ? goal.chars < GOAL_CHARS_MAX
              : goal.percent < GOAL_PERCENT_MAX
          }
          decreaseLabel={t("stats.goal.decrease")}
          increaseLabel={t("stats.goal.increase")}
        />
      </SettingsRow>
      <SettingsBlock>
        <div className="flex items-center gap-4">
          <ProgressRing
            value={target ? done / target : 0}
            className="size-20 shrink-0"
          >
            <span className="text-sm font-medium text-strong tabular-nums">
              {goalPct}%
            </span>
          </ProgressRing>
          <div className="flex min-w-0 flex-col gap-1">
            {target !== null ? (
              <>
                <span className="text-sm text-default tabular-nums">
                  {bookIsPages
                    ? t("stats.goal.progressPages", {
                        done: formatNumber(done),
                        target: formatNumber(target),
                      })
                    : t("stats.goal.progressChars", {
                        done: formatNumber(done),
                        target: formatNumber(target),
                      })}
                </span>
                {goal.mode === "percent" ? (
                  goalBookOptions.length > 0 ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-content">
                      <span className="shrink-0">
                        {t("stats.goal.ofBook", { percent: goal.percent })}
                      </span>
                      <Select
                        value={goalBook?.id ?? goal.bookId ?? ""}
                        onValueChange={(id) => {
                          if (!id) return;
                          update({ ...goal, bookId: id });
                          onGoalBookChange(id);
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={t("stats.goal.bookAria")}
                          className="max-w-44 px-1.5 text-xs"
                        >
                          <SelectValue>
                            {(id: string) => {
                              const option = goalBookOptions.find(
                                (o) => o.id === id,
                              );
                              return option ? (
                                <BookOptionView option={option} />
                              ) : null;
                            }}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {goalBookOptions.map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              <BookOptionView option={option} />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </span>
                  ) : null
                ) : (
                  <span className="text-xs text-muted-content">
                    {done >= target
                      ? t("stats.goal.reached")
                      : t("stats.goal.left", {
                          left: formatNumber(target - done),
                        })}
                  </span>
                )}
              </>
            ) : (
              <span className="text-sm text-muted-content text-pretty">
                {t("stats.goal.noBook")}
              </span>
            )}
          </div>
        </div>
      </SettingsBlock>
    </SettingsGroup>
  );
}
