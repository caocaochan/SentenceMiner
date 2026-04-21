/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {isObjectNotArray} from '../core/object-utilities.js';
import {ExtensionError} from '../core/extension-error.js';
import {deferPromise, generateId} from '../core/utilities.js';

export class FrameClient {
    constructor() {
        /** @type {?string} */
        this._secret = null;
        /** @type {?string} */
        this._token = null;
        /** @type {?number} */
        this._frameId = null;
        /** @type {boolean} */
        this._useWindowMessaging = false;
    }

    /** @type {number} */
    get frameId() {
        if (this._frameId === null) { throw new Error('Not connected'); }
        return this._frameId;
    }

    /**
     * @param {import('extension').HtmlElementWithContentWindow} frame
     * @param {string} targetOrigin
     * @param {number} hostFrameId
     * @param {import('frame-client').SetupFrameFunction} setupFrame
     * @param {number} [timeout]
     */
    async connect(frame, targetOrigin, hostFrameId, setupFrame, timeout = 10000) {
        const {secret, token, frameId, useWindowMessaging} = await this._connectInternal(frame, targetOrigin, hostFrameId, setupFrame, timeout);
        this._secret = secret;
        this._token = token;
        this._frameId = frameId;
        this._useWindowMessaging = useWindowMessaging;
    }

    /**
     * @returns {boolean}
     */
    isConnected() {
        return (this._secret !== null);
    }

    /**
     * @returns {boolean}
     */
    usesWindowMessaging() {
        return this._useWindowMessaging;
    }

    /**
     * @template [T=unknown]
     * @param {T} data
     * @returns {import('frame-client').Message<T>}
     * @throws {Error}
     */
    createMessage(data) {
        if (!this.isConnected()) {
            throw new Error('Not connected');
        }
        return {
            token: /** @type {string} */ (this._token),
            secret: /** @type {string} */ (this._secret),
            data,
        };
    }

    /**
     * @template [T=unknown]
     * @param {import('extension').HtmlElementWithContentWindow} frame
     * @param {string} targetOrigin
     * @param {T} data
     * @param {number} [timeout]
     * @returns {Promise<unknown>}
     */
    invokeWindow(frame, targetOrigin, data, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const contentWindow = frame.contentWindow;
            if (contentWindow === null) {
                reject(new Error('Frame missing content window'));
                return;
            }

            const requestId = generateId(16);
            /** @type {?import('core').Timeout} */
            let timer = null;

            /**
             * @param {MessageEvent<unknown>} event
             */
            const onMessage = (event) => {
                if (event.source !== contentWindow || event.origin !== targetOrigin) { return; }

                const {data: message} = event;
                if (!isObjectNotArray(message)) { return; }
                if (message.sentenceMinerFrameClientFallback !== true || message.action !== 'frameClientDirectApiResponse') { return; }
                if (message.requestId !== requestId) { return; }

                cleanup();
                if (typeof message.error !== 'undefined') {
                    reject(ExtensionError.deserialize(/** @type {import('core').SerializedError} */ (message.error)));
                    return;
                }
                resolve(message.result);
            };

            const cleanup = () => {
                if (timer === null) { return; }
                clearTimeout(timer);
                timer = null;
                window.removeEventListener('message', onMessage, false);
            };

            timer = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout'));
            }, timeout);
            window.addEventListener('message', onMessage, false);

            contentWindow.postMessage({
                sentenceMinerFrameClientFallback: true,
                action: 'frameClientDirectApi',
                requestId,
                message: this.createMessage(data),
            }, targetOrigin);
        });
    }

    /**
     * @param {import('extension').HtmlElementWithContentWindow} frame
     * @param {string} targetOrigin
     * @param {number} hostFrameId
     * @param {(frame: import('extension').HtmlElementWithContentWindow) => void} setupFrame
     * @param {number} timeout
     * @returns {Promise<{secret: string, token: string, frameId: number, useWindowMessaging: boolean}>}
     */
    _connectInternal(frame, targetOrigin, hostFrameId, setupFrame, timeout) {
        return new Promise((resolve, reject) => {
            /** @type {Map<string, string>} */
            const tokenMap = new Map();
            /** @type {?import('core').Timeout} */
            let timer = null;
            const deferPromiseDetails = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
            const frameLoadedPromise = deferPromiseDetails.promise;
            let frameLoadedResolve = /** @type {?() => void} */ (deferPromiseDetails.resolve);
            let frameLoadedReject = /** @type {?(reason?: import('core').RejectionReason) => void} */ (deferPromiseDetails.reject);

            /**
             * @param {string} action
             * @param {import('core').SerializableObject} params
             * @throws {Error}
             */
            const postMessage = (action, params) => {
                const contentWindow = frame.contentWindow;
                if (contentWindow === null) { throw new Error('Frame missing content window'); }

                let validOrigin = true;
                try {
                    validOrigin = (contentWindow.location.origin === targetOrigin);
                } catch (e) {
                    // NOP
                }
                if (!validOrigin) { throw new Error('Unexpected frame origin'); }

                contentWindow.postMessage({action, params}, targetOrigin);
            };

            /** @type {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} */
            const onMessage = (message) => {
                void onMessageInner(message, false);
                return false;
            };

            /**
             * @param {MessageEvent<unknown>} event
             */
            const onWindowMessage = (event) => {
                if (event.source !== frame.contentWindow || event.origin !== targetOrigin) { return; }

                const {data: message} = event;
                if (!isObjectNotArray(message) || message.sentenceMinerFrameClientFallback !== true) { return; }
                void onMessageInner(/** @type {import('application').ApiMessageAny} */ (message), true);
            };

            /**
             * @param {import('application').ApiMessageAny} message
             * @param {boolean} useWindowMessaging
             */
            const onMessageInner = async (message, useWindowMessaging) => {
                try {
                    if (!isObjectNotArray(message)) { return; }
                    const {action, params} = message;
                    if (!isObjectNotArray(params)) { return; }
                    await frameLoadedPromise;
                    if (timer === null) { return; } // Done

                    switch (action) {
                        case 'frameEndpointReady':
                            {
                                const {secret} = params;
                                const token = generateId(16);
                                tokenMap.set(secret, token);
                                postMessage('frameEndpointConnect', {secret, token, hostFrameId});
                            }
                            break;
                        case 'frameEndpointConnected':
                            {
                                const {secret, token} = params;
                                const frameId = message.frameId;
                                const token2 = tokenMap.get(secret);
                                if (typeof token2 !== 'undefined' && token === token2 && typeof frameId === 'number') {
                                    cleanup();
                                    if (useWindowMessaging) {
                                        console.info('SentenceMiner: Yomitan popup frame connected with direct window messaging fallback.');
                                    }
                                    resolve({secret, token, frameId, useWindowMessaging});
                                }
                            }
                            break;
                    }
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            };

            const onLoad = () => {
                if (frameLoadedResolve === null) {
                    cleanup();
                    reject(new Error('Unexpected load event'));
                    return;
                }

                if (FrameClient.isFrameAboutBlank(frame)) {
                    return;
                }

                frameLoadedResolve();
                frameLoadedResolve = null;
                frameLoadedReject = null;
            };

            const cleanup = () => {
                if (timer === null) { return; } // Done
                clearTimeout(timer);
                timer = null;

                frameLoadedResolve = null;
                if (frameLoadedReject !== null) {
                    frameLoadedReject(new Error('Terminated'));
                    frameLoadedReject = null;
                }

                chrome.runtime.onMessage.removeListener(onMessage);
                window.removeEventListener('message', onWindowMessage, false);
                frame.removeEventListener('load', onLoad);
            };

            // Start
            timer = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout'));
            }, timeout);

            chrome.runtime.onMessage.addListener(onMessage);
            window.addEventListener('message', onWindowMessage, false);
            frame.addEventListener('load', onLoad);

            // Prevent unhandled rejections
            frameLoadedPromise.catch(() => {}); // NOP

            try {
                setupFrame(frame);
            } catch (e) {
                cleanup();
                reject(e);
            }
        });
    }

    /**
     * @param {import('extension').HtmlElementWithContentWindow} frame
     * @returns {boolean}
     */
    static isFrameAboutBlank(frame) {
        try {
            const contentDocument = frame.contentDocument;
            if (contentDocument === null) { return false; }
            const url = contentDocument.location.href;
            return /^about:blank(?:[#?]|$)/.test(url);
        } catch (e) {
            return false;
        }
    }
}
