// Move the element at `from` to `to`, in place — the drag-reorder splice
// idiom shared by the shelf grids.
export function moveItem<T>(list: T[], from: number, to: number): void {
  const [moved] = list.splice(from, 1);
  if (moved !== undefined) list.splice(to, 0, moved);
}
