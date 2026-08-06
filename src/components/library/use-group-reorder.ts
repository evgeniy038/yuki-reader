import { useLayoutEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { moveItem } from "@/lib/array";

// Group-level drag-reorder for the shelf: drag a language section's header
// onto another section and the dragged one takes its slot. The dragged
// section collapses out of the flow (it stays mounted — unmounting the drag
// source kills the session), a ghost slot marks the landing position, and
// every shift is a FLIP slide measured off the registered section elements.
export function useGroupReorder({
  groups,
  onReorder,
}: {
  groups: { id: string }[];
  onReorder: (orderedIds: string[]) => void;
}) {
  const dragGroupRef = useRef<string | null>(null);
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const [ghostHeight, setGhostHeight] = useState(0);
  // Section elements by id ("__ghost" for the ghost slot) — the FLIP slide
  // measures and animates these directly.
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const flipTopsRef = useRef<Map<string, number> | null>(null);

  const registerSection = (id: string) => (el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(id, el);
    else sectionRefs.current.delete(id);
  };

  // FLIP: snapshot section tops BEFORE a layout-changing setState, then the
  // layout effect below slides every moved section from its old position.
  // The dragged section is skipped — it collapses in place, not slides.
  const snapshotTops = () => {
    const tops = new Map<string, number>();
    for (const [id, el] of sectionRefs.current) {
      if (id !== dragGroupRef.current) {
        tops.set(id, el.getBoundingClientRect().top);
      }
    }
    flipTopsRef.current = tops;
  };

  useLayoutEffect(() => {
    const tops = flipTopsRef.current;
    flipTopsRef.current = null;
    if (!tops || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    for (const [id, oldTop] of tops) {
      const el = sectionRefs.current.get(id);
      if (!el) continue;
      const delta = oldTop - el.getBoundingClientRect().top;
      if (delta === 0) continue;
      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        { duration: 260, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
      );
    }
  });

  // Drag one group header onto another: the dragged section takes the
  // target's slot (the same splice idiom as the manga volume grid).
  const reorderGroups = (targetId: string) => {
    const fromId = dragGroupRef.current;
    dragGroupRef.current = null;
    setDragGroupId(null);
    setDropGroupId(null);
    if (!fromId || fromId === targetId) return;
    const ids: string[] = groups.map((group) => group.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    moveItem(ids, from, to);
    onReorder(ids);
  };

  // The ghost slot marks where the dragged section would land: below the
  // hovered one on a downward drag (removal shifts later targets back one).
  const ghostIndex = (() => {
    if (!dragGroupId || !dropGroupId || dragGroupId === dropGroupId)
      return null;
    const ids: string[] = groups.map((group) => group.id);
    const from = ids.indexOf(dragGroupId);
    const to = ids.indexOf(dropGroupId);
    if (from === -1 || to === -1) return null;
    return from < to ? to + 1 : to;
  })();

  // Clear every drag artifact; the snapshot makes the restoration slide.
  const finishDrag = () => {
    if (!dragGroupRef.current) return;
    snapshotTops();
    dragGroupRef.current = null;
    setDragGroupId(null);
    setDropGroupId(null);
  };

  const sectionDrag = {
    onDragStart: (group: { id: string }, event: DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag without data set on it.
      event.dataTransfer.setData("text/plain", group.id);
      dragGroupRef.current = group.id;
      snapshotTops();
      setGhostHeight(
        sectionRefs.current.get(group.id)?.getBoundingClientRect().height ?? 0,
      );
      setDragGroupId(group.id);
    },
    onDragOver: (group: { id: string }, event: DragEvent) => {
      if (!dragGroupRef.current || dragGroupRef.current === group.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dropGroupId === group.id) return;
      snapshotTops();
      setDropGroupId(group.id);
    },
    // Drop lands on the list container: section drops bubble up to it, and
    // the pointer-transparent ghost lets events through to it — so the slot
    // marked at that moment is where the section goes. A drop with no slot
    // marked (or an Esc) just puts everything back.
    onContainerDragOver: (event: DragEvent) => {
      if (!dragGroupRef.current) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onContainerDrop: (event: DragEvent) => {
      if (!dragGroupRef.current) return;
      event.preventDefault();
      const targetId = dropGroupId;
      if (targetId && targetId !== dragGroupRef.current) {
        snapshotTops();
        reorderGroups(targetId);
      } else {
        finishDrag();
      }
    },
    onDragEnd: finishDrag,
  };

  return { dragGroupId, ghostHeight, ghostIndex, registerSection, sectionDrag };
}

export type SectionDrag = ReturnType<
  typeof useGroupReorder
>["sectionDrag"];
