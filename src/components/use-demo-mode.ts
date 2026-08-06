import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { useShelf } from "@/components/library/use-shelf";

// Dev-only demo content (?demo / ?demo=h) so vertical layout + line breaking can
// be tuned against deterministic text. Markers make first/last page obvious.
const DEMO_JP =
  "＃始まり＃　主人は動きを止めた。彼の眼は濁って、穴のように光のない黒になった。この人が犯人である可能性は、夕立のとき店内にいた客のだれかが犯人である可能性よりも高いと思っていた。それが正解だったことを僕は知った。……何のことかな？　彼は知らないふりをした。彼は手帳を差し出した。それを見ると、彼は口元に笑みを浮かべた。尖った白い犬歯が覗いた。Ｎ山に森野の死体を捜しに出かけたことと、そこで考えたことを説明した。コーヒーカップをゆっくり下に置き、正面から僕を見た。";
const DEMO_EN =
  "The owner stopped moving. His eyes clouded over, turning a lightless black, like holes. I had thought the chance that this man was the culprit was higher than the chance that any of the customers in the shop during the evening shower was — and that turned out to be correct. He pretended not to know. He held out the notebook, and when I looked at it, a smile surfaced at the corner of his mouth.";

// The ?demo / ?demo=h flag — dev builds only. A plain function, not a hook:
// the shelf store needs the answer before it starts loading.
export function demoModeRequested(): boolean {
  return (
    typeof window !== "undefined" &&
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("demo")
  );
}

// Seeds the deterministic demo book onto the shelf and jumps straight into
// the reader with it.
export function useDemoBook(
  shelf: Pick<
    ReturnType<typeof useShelf>,
    "dataRef" | "setBooks" | "setShelfReady"
  >,
  demoMode: boolean,
): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!demoMode) return;
    const vertical = new URLSearchParams(window.location.search).get("demo") !== "h";
    const paragraph = vertical ? DEMO_JP : DEMO_EN;
    const html = Array.from({ length: vertical ? 30 : 14 })
      .map(() => `<p>${paragraph}</p>`)
      .join("");
    const id = "demo-book";
    const title = vertical ? "デモ（縦書き）" : "Demo (horizontal)";
    shelf.dataRef.current.set(id, {
      metadata: { title },
      chapters: [{ id: "c1", html }],
      resources: [],
      bookCss: "",
      toc: [{ label: vertical ? "デモの章" : "Demo chapter", chapterId: "c1" }],
    });
    shelf.setBooks([
      {
        id,
        title,
        language: vertical ? "ja" : "en",
        format: "epub",
        progress: 0,
        addedAt: Date.now(),
      },
    ]);
    navigate(`/read/${id}`);
    shelf.setShelfReady(true);
    document.title = vertical ? "yuki · demo (vertical)" : "yuki · demo (horizontal)";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode]);
}
