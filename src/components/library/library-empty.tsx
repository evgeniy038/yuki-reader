import { Books, Plus } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

// Empty shelf, centered on the page: icon, one line and the accent action
// that fills the shelf. Shared by the home and library views — the parent is
// expected to be a full-height flex column so this centers vertically.
export function LibraryEmpty({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid flex-1 place-items-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Books />
          </EmptyMedia>
          <EmptyTitle>{t("library.empty.title")}</EmptyTitle>
          <EmptyDescription>{t("library.empty.body")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onAdd}>
            <Plus />
            {t("library.addBook")}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
