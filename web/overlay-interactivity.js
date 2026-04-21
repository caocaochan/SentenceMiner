export function shouldOverlayBeInteractive({
  hasSelection = false,
  pointerOverSubtitle = false,
  selectionActive = false,
  yomitanPopupVisible = false,
} = {}) {
  return Boolean(hasSelection || pointerOverSubtitle || selectionActive || yomitanPopupVisible);
}

export function hasVisibleYomitanPopup(root = document, getStyle = globalThis.getComputedStyle) {
  const popups = root.querySelectorAll?.('iframe.yomitan-popup') ?? [];
  for (const popup of popups) {
    if (isVisiblePopupElement(popup, getStyle)) { return true; }
  }

  return false;
}

export function shouldCloseYomitanPopupOnPointerDown({
  button = 0,
  clientX = 0,
  clientY = 0,
  yomitanPopupVisible = false,
  root = document,
  getStyle = globalThis.getComputedStyle,
} = {}) {
  if (button !== 0 || !yomitanPopupVisible) {
    return false;
  }

  return !isPointInVisibleYomitanPopup(root, clientX, clientY, getStyle);
}

export function isPointInVisibleYomitanPopup(root = document, x = 0, y = 0, getStyle = globalThis.getComputedStyle) {
  const popups = root.querySelectorAll?.('iframe.yomitan-popup') ?? [];
  for (const popup of popups) {
    if (!isVisiblePopupElement(popup, getStyle)) {
      continue;
    }

    const rect = popup.getBoundingClientRect?.();
    if (!rect) {
      continue;
    }

    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
      return true;
    }
  }

  return false;
}

function isVisiblePopupElement(popup, getStyle) {
  if (popup.hidden) {
    return false;
  }

  const style = typeof getStyle === 'function' ? getStyle(popup) : popup.style;
  if (style?.display === 'none' || style?.visibility === 'hidden') {
    return false;
  }

  const rect = popup.getBoundingClientRect?.();
  if (rect && (rect.width <= 0 || rect.height <= 0)) {
    return false;
  }

  return true;
}
