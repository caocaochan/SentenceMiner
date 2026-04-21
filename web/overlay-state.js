export function buildOverlaySubtitleView(statePayload) {
  const subtitle = statePayload?.state?.currentSubtitle;
  const text = typeof subtitle?.text === 'string' ? subtitle.text.trim() : '';
  const sessionActive = Boolean(statePayload?.state?.session);

  return {
    visible: sessionActive && text.length > 0,
    text,
  };
}

export function buildOverlayStatusPayload(statePayload) {
  const view = buildOverlaySubtitleView(statePayload);
  const sessionId = statePayload?.state?.session?.sessionId;

  return {
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
    visible: view.visible,
    text: view.visible ? view.text : '',
  };
}

export function buildOverlayStyleVars(statePayload) {
  const overlay = statePayload?.config?.overlay ?? {};
  const fontSizePx = clampNumber(overlay.fontSizePx, 12, 96, 42);
  const bottomOffsetPct = clampNumber(overlay.bottomOffsetPct, 0, 45, 14);
  const maxWidthPct = clampNumber(overlay.maxWidthPct, 25, 100, 86);
  const fontFamily =
    overlay.fontFamily?.trim?.() ||
    statePayload?.config?.appearance?.subtitleCardFontFamily?.trim?.() ||
    '';

  return {
    '--overlay-font-size': `${fontSizePx}px`,
    '--overlay-bottom-offset': `${bottomOffsetPct}%`,
    '--overlay-max-width': `${maxWidthPct}%`,
    '--overlay-font-family': fontFamily || 'system-ui, sans-serif',
  };
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numeric));
}
