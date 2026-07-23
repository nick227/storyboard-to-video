const FORM_CONTROL = 'input,textarea,select,label,[contenteditable="true"]';
const INTERACTIVE = `a,button,${FORM_CONTROL},video,audio`;

function isInteractiveTarget(target) {
  return Boolean(target?.closest?.(INTERACTIVE));
}

function isFormControl(target) {
  return Boolean(target?.closest?.(FORM_CONTROL));
}

/** Horizontal grab-to-scroll for overflow containers (filmstrip). */
export function enableDragScroll(element, { axis = 'x' } = {}) {
  if (!element || element.dataset.dragScrollBound === '1') return () => {};
  element.dataset.dragScrollBound = '1';
  element.classList.add('is-grab-scroll');

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;
  let moved = false;

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isFormControl(event.target)) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startScrollLeft = element.scrollLeft;
    startScrollTop = element.scrollTop;
    moved = false;
    element.classList.add('is-grabbing');
    element.setPointerCapture?.(pointerId);
  };

  const onPointerMove = (event) => {
    if (pointerId == null || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    event.preventDefault();
    if (axis === 'x' || axis === 'both') element.scrollLeft = startScrollLeft - dx;
    if (axis === 'y' || axis === 'both') element.scrollTop = startScrollTop - dy;
  };

  const end = (event) => {
    if (pointerId == null || event.pointerId !== pointerId) return;
    element.releasePointerCapture?.(pointerId);
    element.classList.remove('is-grabbing');
    if (moved) element.dataset.suppressClick = '1';
    pointerId = null;
    moved = false;
  };

  const onClickCapture = (event) => {
    if (element.dataset.suppressClick !== '1') return;
    event.preventDefault();
    event.stopPropagation();
    delete element.dataset.suppressClick;
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
  element.addEventListener('click', onClickCapture, true);

  return () => {
    delete element.dataset.dragScrollBound;
    element.classList.remove('is-grab-scroll', 'is-grabbing');
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', end);
    element.removeEventListener('pointercancel', end);
    element.removeEventListener('click', onClickCapture, true);
  };
}

/** Horizontal swipe on the stage to change scenes. */
export function enableStageSwipe(element, { onSwipeLeft, onSwipeRight, threshold = 56 } = {}) {
  if (!element || element.dataset.stageSwipeBound === '1') return () => {};
  element.dataset.stageSwipeBound = '1';
  element.classList.add('is-grab-stage');

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let tracking = false;

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isInteractiveTarget(event.target)) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    tracking = true;
    element.classList.add('is-grabbing');
    element.setPointerCapture?.(pointerId);
  };

  const onPointerMove = (event) => {
    if (!tracking || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) event.preventDefault();
  };

  const end = (event) => {
    if (!tracking || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    element.releasePointerCapture?.(pointerId);
    element.classList.remove('is-grabbing');
    tracking = false;
    pointerId = null;
    if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) onSwipeLeft?.();
    else onSwipeRight?.();
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove, { passive: false });
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);

  return () => {
    delete element.dataset.stageSwipeBound;
    element.classList.remove('is-grab-stage', 'is-grabbing');
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', end);
    element.removeEventListener('pointercancel', end);
  };
}
