const FORM_CONTROL = 'input,textarea,select,label,[contenteditable="true"]';
const CLICK_CONTROL = 'button,a[href]';

function isFormControl(target) {
  return Boolean(target?.closest?.(FORM_CONTROL));
}

function isClickControl(target) {
  return Boolean(target?.closest?.(CLICK_CONTROL));
}

function suppressNativeDrag(element) {
  const onDragStart = (event) => event.preventDefault();
  element.addEventListener('dragstart', onDragStart);
  return () => element.removeEventListener('dragstart', onDragStart);
}

/** Horizontal grab-to-scroll for overflow containers (filmstrip). */
export function enableDragScroll(element, { axis = 'x' } = {}) {
  if (!element || element.dataset.dragScrollBound === '1') return () => {};
  element.dataset.dragScrollBound = '1';
  element.classList.add('is-grab-scroll');
  const unbindDragStart = suppressNativeDrag(element);

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
    try { element.setPointerCapture(pointerId); } catch (_) {}
  };

  const onPointerMove = (event) => {
    if (pointerId == null || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    if (event.cancelable) event.preventDefault();
    if (axis === 'x' || axis === 'both') element.scrollLeft = startScrollLeft - dx;
    if (axis === 'y' || axis === 'both') element.scrollTop = startScrollTop - dy;
  };

  const end = (event) => {
    if (pointerId == null || event.pointerId !== pointerId) return;
    try { element.releasePointerCapture(pointerId); } catch (_) {}
    element.classList.remove('is-grabbing');
    if (moved) element.dataset.suppressClick = '1';
    pointerId = null;
    moved = false;
  };

  const onLostCapture = () => {
    pointerId = null;
    moved = false;
    element.classList.remove('is-grabbing');
  };

  const onClickCapture = (event) => {
    if (element.dataset.suppressClick !== '1') return;
    event.preventDefault();
    event.stopPropagation();
    delete element.dataset.suppressClick;
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove, { passive: false });
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
  element.addEventListener('lostpointercapture', onLostCapture);
  element.addEventListener('click', onClickCapture, true);

  return () => {
    delete element.dataset.dragScrollBound;
    element.classList.remove('is-grab-scroll', 'is-grabbing');
    unbindDragStart();
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', end);
    element.removeEventListener('pointercancel', end);
    element.removeEventListener('lostpointercapture', onLostCapture);
    element.removeEventListener('click', onClickCapture, true);
  };
}

/** Horizontal swipe on the stage to change scenes. */
export function enableStageSwipe(element, { onSwipeLeft, onSwipeRight, threshold = 48 } = {}) {
  if (!element || element.dataset.stageSwipeBound === '1') return () => {};
  element.dataset.stageSwipeBound = '1';
  element.classList.add('is-grab-stage');
  const unbindDragStart = suppressNativeDrag(element);

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let moved = false;
  let tracking = false;

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Pointer capture retargets the eventual click to the stage. Do not start a
    // swipe from buttons/links inside the scene card, or their click handlers
    // (including the entity-modal status buttons) will never receive the click.
    if (isFormControl(event.target) || isClickControl(event.target)) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    moved = false;
    tracking = true;
    element.classList.add('is-grabbing');
    try { element.setPointerCapture(pointerId); } catch (_) {}
  };

  const onPointerMove = (event) => {
    if (!tracking || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    moved = true;
    if (Math.abs(dx) > Math.abs(dy) && event.cancelable) event.preventDefault();
  };

  const end = (event) => {
    if (!tracking || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    try { element.releasePointerCapture(pointerId); } catch (_) {}
    element.classList.remove('is-grabbing');
    tracking = false;
    pointerId = null;
    if (!moved) return;
    element.dataset.suppressClick = '1';
    if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.15) return;
    if (dx < 0) onSwipeLeft?.();
    else onSwipeRight?.();
  };

  const onLostCapture = () => {
    tracking = false;
    pointerId = null;
    moved = false;
    element.classList.remove('is-grabbing');
  };

  const onClickCapture = (event) => {
    if (element.dataset.suppressClick !== '1') return;
    event.preventDefault();
    event.stopPropagation();
    delete element.dataset.suppressClick;
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove, { passive: false });
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
  element.addEventListener('lostpointercapture', onLostCapture);
  element.addEventListener('click', onClickCapture, true);

  return () => {
    delete element.dataset.stageSwipeBound;
    element.classList.remove('is-grab-stage', 'is-grabbing');
    unbindDragStart();
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', end);
    element.removeEventListener('pointercancel', end);
    element.removeEventListener('lostpointercapture', onLostCapture);
    element.removeEventListener('click', onClickCapture, true);
  };
}
