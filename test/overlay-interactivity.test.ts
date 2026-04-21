import test from 'node:test';
import assert from 'node:assert/strict';

import { hasVisibleYomitanPopup, shouldOverlayBeInteractive } from '../web/overlay-interactivity.js';

test('shouldOverlayBeInteractive follows subtitle, selection, and Yomitan popup state', () => {
  assert.equal(shouldOverlayBeInteractive(), false);
  assert.equal(shouldOverlayBeInteractive({ pointerOverSubtitle: true }), true);
  assert.equal(shouldOverlayBeInteractive({ selectionActive: true }), true);
  assert.equal(shouldOverlayBeInteractive({ hasSelection: true }), true);
  assert.equal(shouldOverlayBeInteractive({ yomitanPopupVisible: true }), true);
});

test('hasVisibleYomitanPopup detects a rendered Yomitan iframe', () => {
  const visiblePopup = createPopup({
    display: 'block',
    visibility: 'visible',
    width: 320,
    height: 180,
  });
  const hiddenPopup = createPopup({
    display: 'block',
    visibility: 'hidden',
    width: 320,
    height: 180,
  });
  const collapsedPopup = createPopup({
    display: 'block',
    visibility: 'visible',
    width: 0,
    height: 0,
  });

  assert.equal(hasVisibleYomitanPopup(createRoot([hiddenPopup]), readStyle), false);
  assert.equal(hasVisibleYomitanPopup(createRoot([collapsedPopup]), readStyle), false);
  assert.equal(hasVisibleYomitanPopup(createRoot([visiblePopup]), readStyle), true);
});

function createRoot(popups) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, 'iframe.yomitan-popup');
      return popups;
    },
  };
}

function createPopup({ display, visibility, width, height }) {
  return {
    hidden: false,
    style: {
      display,
      visibility,
    },
    getBoundingClientRect() {
      return { width, height };
    },
  };
}

function readStyle(element) {
  return element.style;
}
