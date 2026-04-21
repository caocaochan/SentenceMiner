/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {getFieldMarkers} from './anki-util.js';

/**
 * This function returns whether an Anki field marker might require clipboard permissions.
 * This is speculative and may not guarantee that the field marker actually does require the permission,
 * as the custom handlebars template is not deeply inspected.
 * @param {string} marker
 * @returns {boolean}
 */
function ankiFieldMarkerMayUseClipboard(marker) {
    switch (marker) {
        case 'clipboard-image':
        case 'clipboard-text':
            return true;
        default:
            return false;
    }
}

/**
 * @param {chrome.permissions.Permissions} permissions
 * @returns {Promise<boolean>}
 */
export function hasPermissions(permissions) {
    if (!canUseChromePermissionsMethod('contains')) {
        return getFallbackPermissions().then((grantedPermissions) => hasAllPermissions(grantedPermissions, permissions));
    }

    return new Promise((resolve, reject) => {
        chrome.permissions.contains(permissions, (result) => {
            const e = chrome.runtime.lastError;
            if (e) {
                reject(new Error(e.message));
            } else {
                resolve(result);
            }
        });
    });
}

/**
 * @param {chrome.permissions.Permissions} permissions
 * @param {boolean} shouldHave
 * @returns {Promise<boolean>}
 */
export function setPermissionsGranted(permissions, shouldHave) {
    if (!canUseChromePermissionsMethod(shouldHave ? 'request' : 'remove')) {
        return Promise.resolve(shouldHave);
    }

    return (
        shouldHave ?
        new Promise((resolve, reject) => {
            chrome.permissions.request(permissions, (result) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(result);
                }
            });
        }) :
        new Promise((resolve, reject) => {
            chrome.permissions.remove(permissions, (result) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(!result);
                }
            });
        })
    );
}

/**
 * @returns {Promise<chrome.permissions.Permissions>}
 */
export function getAllPermissions() {
    if (!canUseChromePermissionsMethod('getAll')) {
        return getFallbackPermissions();
    }

    return new Promise((resolve, reject) => {
        chrome.permissions.getAll((result) => {
            const e = chrome.runtime.lastError;
            if (e) {
                reject(new Error(e.message));
            } else {
                resolve(result);
            }
        });
    });
}

/**
 * Electron can load the extension but does not expose Chrome's dynamic permissions API.
 * Keep this manifest-based fallback so the backend can start inside SentenceMiner's overlay.
 * @param {'contains'|'getAll'|'remove'|'request'} method
 * @returns {boolean}
 */
function canUseChromePermissionsMethod(method) {
    return (
        typeof chrome === 'object' &&
        chrome !== null &&
        typeof chrome.permissions === 'object' &&
        chrome.permissions !== null &&
        typeof chrome.permissions[method] === 'function'
    );
}

/**
 * @returns {Promise<chrome.permissions.Permissions>}
 */
async function getFallbackPermissions() {
    const manifest = (
        typeof chrome === 'object' &&
        chrome !== null &&
        typeof chrome.runtime === 'object' &&
        chrome.runtime !== null &&
        typeof chrome.runtime.getManifest === 'function'
    ) ? chrome.runtime.getManifest() : {};

    return {
        permissions: uniqueStrings([
            ...arrayFromManifestField(manifest.permissions),
            ...arrayFromManifestField(manifest.optional_permissions),
        ]),
        origins: uniqueStrings(arrayFromManifestField(manifest.host_permissions)),
    };
}

/**
 * @param {chrome.permissions.Permissions} grantedPermissions
 * @param {chrome.permissions.Permissions} requiredPermissions
 * @returns {boolean}
 */
function hasAllPermissions(grantedPermissions, requiredPermissions) {
    return hasAllStrings(grantedPermissions.permissions, requiredPermissions.permissions) &&
        hasAllStrings(grantedPermissions.origins, requiredPermissions.origins);
}

/**
 * @param {string[]|undefined} available
 * @param {string[]|undefined} required
 * @returns {boolean}
 */
function hasAllStrings(available, required) {
    if (!Array.isArray(required) || required.length === 0) {
        return true;
    }

    const availableSet = new Set(Array.isArray(available) ? available : []);
    return required.every((value) => availableSet.has(value));
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function arrayFromManifestField(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
    return [...new Set(values)];
}

/**
 * @param {string} fieldValue
 * @returns {string[]}
 */
export function getRequiredPermissionsForAnkiFieldValue(fieldValue) {
    const markers = getFieldMarkers(fieldValue);
    for (const marker of markers) {
        if (ankiFieldMarkerMayUseClipboard(marker)) {
            return ['clipboardRead'];
        }
    }
    return [];
}

/**
 * @param {chrome.permissions.Permissions} permissions
 * @param {import('settings').ProfileOptions} options
 * @returns {boolean}
 */
export function hasRequiredPermissionsForOptions(permissions, options) {
    const permissionsSet = new Set(permissions.permissions);

    if (!permissionsSet.has('nativeMessaging') && (options.parsing.enableMecabParser || options.general.enableYomitanApi)) {
        return false;
    }

    if (!permissionsSet.has('clipboardRead')) {
        if (options.clipboard.enableBackgroundMonitor || options.clipboard.enableSearchPageMonitor) {
            return false;
        }
        const fieldsList = options.anki.cardFormats.map((cardFormat) => cardFormat.fields);

        for (const fields of fieldsList) {
            for (const {value: fieldValue} of Object.values(fields)) {
                const markers = getFieldMarkers(fieldValue);
                for (const marker of markers) {
                    if (ankiFieldMarkerMayUseClipboard(marker)) {
                        return false;
                    }
                }
            }
        }
    }

    return true;
}
