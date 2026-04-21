import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasVisibleYomitanPopup,
  isPointInVisibleYomitanPopup,
  shouldCloseYomitanPopupOnPointerDown,
  shouldOverlayBeInteractive,
} from '../web/overlay-interactivity.js';

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
    left: 10,
    top: 20,
    width: 320,
    height: 180,
  });
  const hiddenPopup = createPopup({
    display: 'block',
    visibility: 'hidden',
    left: 10,
    top: 20,
    width: 320,
    height: 180,
  });
  const collapsedPopup = createPopup({
    display: 'block',
    visibility: 'visible',
    left: 10,
    top: 20,
    width: 0,
    height: 0,
  });

  assert.equal(hasVisibleYomitanPopup(createRoot([hiddenPopup]), readStyle), false);
  assert.equal(hasVisibleYomitanPopup(createRoot([collapsedPopup]), readStyle), false);
  assert.equal(hasVisibleYomitanPopup(createRoot([visiblePopup]), readStyle), true);
});

test('shouldCloseYomitanPopupOnPointerDown closes only for primary clicks outside the popup', () => {
  const root = createRoot([
    createPopup({
      display: 'block',
      visibility: 'visible',
      left: 100,
      top: 50,
      width: 320,
      height: 180,
    }),
  ]);

  assert.equal(isPointInVisibleYomitanPopup(root, 150, 80, readStyle), true);
  assert.equal(isPointInVisibleYomitanPopup(root, 50, 80, readStyle), false);
  assert.equal(shouldCloseYomitanPopupOnPointerDown({
    button: 0,
    clientX: 150,
    clientY: 80,
    yomitanPopupVisible: true,
    root,
    getStyle: readStyle,
  }), false);
  assert.equal(shouldCloseYomitanPopupOnPointerDown({
    button: 0,
    clientX: 50,
    clientY: 80,
    yomitanPopupVisible: true,
    root,
    getStyle: readStyle,
  }), true);
  assert.equal(shouldCloseYomitanPopupOnPointerDown({
    button: 2,
    clientX: 50,
    clientY: 80,
    yomitanPopupVisible: true,
    root,
    getStyle: readStyle,
  }), false);
  assert.equal(shouldCloseYomitanPopupOnPointerDown({
    button: 0,
    clientX: 50,
    clientY: 80,
    yomitanPopupVisible: false,
    root,
    getStyle: readStyle,
  }), false);
});

function createRoot(popups) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, 'iframe.yomitan-popup');
      return popups;
    },
  };
}

function createPopup({ display, visibility, left, top, width, height }) {
  return {
    hidden: false,
    style: {
      display,
      visibility,
    },
    getBoundingClientRect() {
      return {
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
      };
    },
  };
}

function readStyle(element) {
  return element.style;
}
