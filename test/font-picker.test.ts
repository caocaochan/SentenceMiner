import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOM_FONT_OPTION_VALUE,
  resolveFontPickerState,
  resolveFontSettingValue,
} from '../web/font-picker.js';

test('resolveFontPickerState selects the default option when no font is saved', () => {
  assert.deepEqual(resolveFontPickerState(['Arial', 'Noto Sans JP'], ''), {
    selectValue: '',
    customValue: '',
    showCustomInput: false,
  });
});

test('resolveFontPickerState selects an installed font when it matches exactly', () => {
  assert.deepEqual(resolveFontPickerState(['Arial', 'Noto Sans JP'], 'Noto Sans JP'), {
    selectValue: 'Noto Sans JP',
    customValue: '',
    showCustomInput: false,
  });
});

test('resolveFontPickerState falls back to the custom option for font stacks', () => {
  assert.deepEqual(resolveFontPickerState(['Arial', 'Noto Sans JP'], 'Noto Sans JP, sans-serif'), {
    selectValue: CUSTOM_FONT_OPTION_VALUE,
    customValue: 'Noto Sans JP, sans-serif',
    showCustomInput: true,
  });
});

test('resolveFontSettingValue only uses the custom input when the custom option is selected', () => {
  assert.equal(resolveFontSettingValue(CUSTOM_FONT_OPTION_VALUE, ' Noto Sans JP, sans-serif '), 'Noto Sans JP, sans-serif');
  assert.equal(resolveFontSettingValue('Arial', 'Noto Sans JP, sans-serif'), 'Arial');
});
