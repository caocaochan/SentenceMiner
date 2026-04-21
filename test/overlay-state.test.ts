import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOverlayStatusPayload, buildOverlayStyleVars, buildOverlaySubtitleView } from '../web/overlay-state.js';

test('buildOverlaySubtitleView hides the overlay without an active subtitle', () => {
  assert.deepEqual(
    buildOverlaySubtitleView({
      state: {
        session: { sessionId: 'session-1' },
        currentSubtitle: null,
      },
    }),
    {
      visible: false,
      text: '',
    },
  );
});

test('buildOverlaySubtitleView exposes trimmed active subtitle text', () => {
  assert.deepEqual(
    buildOverlaySubtitleView({
      state: {
        session: { sessionId: 'session-1' },
        currentSubtitle: {
          text: '  selectable subtitle text  ',
        },
      },
    }),
    {
      visible: true,
      text: 'selectable subtitle text',
    },
  );
});

test('buildOverlayStatusPayload reports the rendered overlay subtitle', () => {
  assert.deepEqual(
    buildOverlayStatusPayload({
      state: {
        session: { sessionId: 'session-1' },
        currentSubtitle: {
          text: '  selectable subtitle text  ',
        },
      },
    }),
    {
      sessionId: 'session-1',
      visible: true,
      text: 'selectable subtitle text',
    },
  );
});

test('buildOverlayStatusPayload reports hidden state without stale text', () => {
  assert.deepEqual(
    buildOverlayStatusPayload({
      state: {
        session: { sessionId: 'session-1' },
        currentSubtitle: null,
      },
    }),
    {
      sessionId: 'session-1',
      visible: false,
      text: '',
    },
  );
});

test('buildOverlayStyleVars clamps overlay sizing settings', () => {
  assert.deepEqual(
    buildOverlayStyleVars({
      config: {
        appearance: {
          subtitleCardFontFamily: 'Noto Sans JP',
        },
        overlay: {
          fontFamily: 'Yu Gothic UI',
          fontSizePx: 200,
          bottomOffsetPct: -5,
          maxWidthPct: 10,
        },
      },
    }),
    {
      '--overlay-font-size': '96px',
      '--overlay-bottom-offset': '0%',
      '--overlay-max-width': '25%',
      '--overlay-font-family': 'Yu Gothic UI',
    },
  );
});

test('buildOverlayStyleVars falls back to the transcript font when overlay font is unset', () => {
  assert.equal(
    buildOverlayStyleVars({
      config: {
        appearance: {
          subtitleCardFontFamily: 'Noto Sans JP',
        },
        overlay: {
          fontFamily: '',
        },
      },
    })['--overlay-font-family'],
    'Noto Sans JP',
  );
});
