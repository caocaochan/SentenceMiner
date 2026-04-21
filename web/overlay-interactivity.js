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
    if (popup.hidden) {
      continue;
    }

    const style = typeof getStyle === 'function' ? getStyle(popup) : popup.style;
    if (style?.display === 'none' || style?.visibility === 'hidden') {
      continue;
    }

    const rect = popup.getBoundingClientRect?.();
    if (rect && (rect.width <= 0 || rect.height <= 0)) {
      continue;
    }

    return true;
  }

  return false;
}
