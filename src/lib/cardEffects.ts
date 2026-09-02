function getScrollParent(el: HTMLElement): HTMLElement | null {
  return el.closest(".scrollbar-column") as HTMLElement | null;
}

export function liftCard(taskId: string) {
  const el = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const scroll = getScrollParent(el);
  if (scroll) scroll.style.overflow = "visible";
  el.style.position = "relative";
  el.style.zIndex = "35";
  el.style.transition = "transform 200ms ease-out, box-shadow 200ms ease-out";
  el.style.transform = "scale(1.03)";
  el.style.boxShadow = "0 8px 32px rgba(0,0,0,0.25)";
}

export function slideCard(taskId: string, targetStatus: string) {
  const card = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement | null;
  const col = document.querySelector(`[data-column-status="${targetStatus}"]`) as HTMLElement | null;
  if (!card || !col) return;
  const deltaX = col.getBoundingClientRect().left + 16 - card.getBoundingClientRect().left;
  card.style.transition = "transform 600ms ease-in-out";
  card.style.transform = `translateX(${deltaX}px) scale(1.03)`;
}

export function resetCard(taskId: string) {
  const el = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement | null;
  if (!el) return;
  el.style.opacity = "0";
  el.style.transition = "none";
}

export function clearCardStyles(taskId: string) {
  const el = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement | null;
  if (!el) return;
  const scroll = getScrollParent(el);
  if (scroll) scroll.style.overflow = "";
  el.style.cssText = "";
}

export function glowCard(taskId: string) {
  const el = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement | null;
  if (!el) return;
  el.style.borderColor = "rgba(34, 211, 238, 0.3)";
  el.style.boxShadow = "0 0 20px rgba(34, 211, 238, 0.12)";
  el.style.transition = "border-color 400ms, box-shadow 400ms";
}

export function unglowCard(taskId: string) {
  const el = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement | null;
  if (el) el.style.cssText = "";
}
