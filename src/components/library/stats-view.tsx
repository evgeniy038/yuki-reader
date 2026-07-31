import { useEffect, useState } from "react";
import { ChartLine } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DashRing } from "@/components/ui/dash-ring";
import { loadStats, type DailyStats } from "@/core/storage";
import { dayKey, streaks, totals } from "@/core/stats";
import { speedLabel } from "@/lib/format";
import type { GoalBook } from "./use-goal-book";
import {
  PageContent,
  PageHeader,
  PageShell,
  PageTitle,
} from "./page-shell";
import { SummarySection } from "./summary-section";
import { ActivityHeatmap } from "./activity-heatmap";
import { GoalSection, type GoalBookOption } from "./goal-section";

// Statistics page — the habit surface: today's numbers, a streak, the
// activity heatmap (half a year, GitHub-style) and the daily goal. Raw data
// is one record per local day, accumulated by the reading session (App.tsx);
// the sections own their specifics. The view remounts on every visit, so
// mount-time loading is enough. The page keeps the settings width (max-w-lg)
// and rhythm.
export function StatsView({
  goalBook,
  goalBookOptions,
  onGoalBookChange,
}: {
  goalBook?: GoalBook;
  goalBookOptions: GoalBookOption[];
  onGoalBookChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [days, setDays] = useState<DailyStats[] | null>(null);

  useEffect(() => {
    let alive = true;
    void loadStats().then((loaded) => {
      if (alive) setDays(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  const todayKey = dayKey(Date.now());
  const today = days?.find((d) => d.date === todayKey);

  return (
    <PageShell>
      <PageHeader>
        <PageTitle>{t("stats.title")}</PageTitle>
      </PageHeader>
      <PageContent className="mx-auto w-full max-w-lg gap-6">
        {days === null ? (
          <div className="grid flex-1 place-items-center">
            <DashRing className="size-6 text-muted-content" />
          </div>
        ) : days.length === 0 ? (
          <div className="grid flex-1 place-items-center">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ChartLine />
                </EmptyMedia>
                <EmptyTitle>{t("stats.empty.title")}</EmptyTitle>
                <EmptyDescription>{t("stats.empty.body")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <>
            <SummarySection
              today={today}
              streak={streaks(days, todayKey)}
              total={totals(days)}
              todaySpeed={today ? speedLabel(today) : null}
            />
            <ActivityHeatmap days={days} todayKey={todayKey} />
            <GoalSection
              todayChars={today?.chars ?? 0}
              todayPages={today?.pages ?? 0}
              goalBook={goalBook}
              goalBookOptions={goalBookOptions}
              onGoalBookChange={onGoalBookChange}
            />
          </>
        )}
      </PageContent>
    </PageShell>
  );
}
