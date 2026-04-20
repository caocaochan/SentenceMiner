export const CUSTOM_FONT_OPTION_VALUE = '__custom__';

export function resolveFontPickerState(fonts, savedValue) {
  const availableFonts = normalizeAvailableFonts(fonts);
  const currentValue = (savedValue ?? '').trim();

  if (!currentValue) {
    return {
      selectValue: '',
      customValue: '',
      showCustomInput: false,
    };
  }

  if (availableFonts.includes(currentValue)) {
    return {
      selectValue: currentValue,
      customValue: '',
      showCustomInput: false,
    };
  }

  return {
    selectValue: CUSTOM_FONT_OPTION_VALUE,
    customValue: currentValue,
    showCustomInput: true,
  };
}

export function resolveFontSettingValue(selectValue, customValue) {
  const normalizedSelectValue = (selectValue ?? '').trim();
  if (normalizedSelectValue === CUSTOM_FONT_OPTION_VALUE) {
    return (customValue ?? '').trim();
  }

  return normalizedSelectValue;
}

function normalizeAvailableFonts(fonts) {
  return [...new Set((fonts ?? []).map((font) => String(font ?? '').trim()).filter(Boolean))];
}
