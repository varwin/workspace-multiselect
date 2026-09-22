/**
 * @license
 * Copyright 2026 Varwin
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Carrying the buffer in the clipboard of the system.
 *
 * The storage the crossTab buffer is written to belongs to one origin, so what
 * it carries reaches the other windows of the same page and nothing else -
 * neither another installation of the editor, nor a page elsewhere offering
 * blocks for one to paste. The clipboard of the system has neither limit.
 *
 * Text that is not an envelope of ours belongs to whoever else the paste was
 * meant for, so it is left alone.
 *
 * The envelope travels deflated: block JSON repeats itself - the same types,
 * the same instance guids, the same signatures - and a screenful of blocks is
 * tens of kilobytes of it. The marker rides inside, so reading the clipboard is
 * trying to unpack it.
 */

import {deflateSync, inflateSync, strFromU8, strToU8} from 'fflate';

import {connectionDBList, copyData, setCopyExtras} from './global';

const MARKER = 'blocklyClipboard';
const FORMAT = 2;

/**
 * The format before the buffer was deflated. Read, never written: a buffer
 * copied by an older editor is still a buffer.
 */
const PLAIN_FORMAT = 1;

/**
 * Whether the buffer travels through the clipboard of the system. It belongs
 * to the page rather than to a workspace, as do the shortcuts reading it.
 */
let inUse = false;

/**
 * @param {boolean} on Whether to use the clipboard of the system.
 */
export const setSystemClipboard = function(on) {
  inUse = on === true;
};

/**
 * @returns {boolean} Whether the clipboard of the system is in use.
 */
export const useSystemClipboard = function() {
  return inUse;
};

/**
 * @param {string} text The text to read.
 * @returns {?Object} What it holds, or null if it holds no JSON at all.
 */
const parseJson = function(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
};

/**
 * @param {!Uint8Array} bytes The bytes to encode.
 * @returns {string} Their base64, in pieces small enough to apply at once.
 */
const toBase64 = function(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + CHUNK));
  }

  return btoa(binary);
};

/**
 * @param {string} text The base64 to decode.
 * @returns {!Uint8Array} The bytes it holds.
 */
const fromBase64 = function(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) {
    bytes[at] = binary.charCodeAt(at);
  }

  return bytes;
};

/**
 * @param {?Object} extras Whatever the hooks of the host sent with the buffer.
 * @returns {!Object} The buffer itself, before it is packed into an envelope.
 */
const collectBuffer = function(extras) {
  const blocks = [];
  copyData.forEach(function(data) {
    const block = typeof data === 'string' ? parseJson(data) : data;
    if (!block) return;

    // The workspace an entry was copied on says nothing to whoever reads it.
    delete block.source;
    blocks.push(block);
  });

  const buffer = {blocks: blocks, connections: connectionDBList.slice()};
  if (extras && Object.keys(extras).length) {
    buffer.extras = extras;
  }

  return buffer;
};

/**
 * @param {?Object} extras Whatever the hooks of the host sent with the buffer.
 * @returns {string} The envelope to put on the clipboard.
 */
export const buildClipboardText = function(extras) {
  const buffer = collectBuffer(extras);
  const envelope = {};
  envelope[MARKER] = FORMAT;
  envelope.blocks = buffer.blocks;
  envelope.connections = buffer.connections;
  if (buffer.extras) envelope.extras = buffer.extras;

  const text = JSON.stringify(envelope);

  try {
    return toBase64(deflateSync(strToU8(text), {level: 9}));
  } catch (e) {
    // A buffer nobody here can pack is still a buffer, and open it is read by
    // an editor of either version.
    envelope[MARKER] = PLAIN_FORMAT;
    return JSON.stringify(envelope);
  }
};

/**
 * @param {string} text The text read from the clipboard.
 * @returns {?Object} The envelope it holds, or null if it holds none.
 */
const unpackEnvelope = function(text) {
  try {
    return parseJson(strFromU8(inflateSync(fromBase64(text))));
  } catch (e) {
    return null;
  }
};

/**
 * What is on the clipboard was put there by anybody at all, so nothing about
 * an envelope is taken on trust beyond its own shape.
 * @param {?string} text The text read from the clipboard.
 * @returns {?Object} The buffer it holds, or null if it holds none.
 */
export const parseClipboardText = function(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  // An editor that wrote its envelope in the open is still one to paste from.
  const envelope = trimmed.charAt(0) === '{' ?
      parseJson(trimmed) :
      unpackEnvelope(trimmed);
  if (!envelope || typeof envelope !== 'object') return null;

  // A format this one does not know is a buffer whose meaning is exactly what
  // cannot be told from here.
  const format = envelope[MARKER];
  if (typeof format !== 'number' || format > FORMAT) return null;

  if (!Array.isArray(envelope.blocks)) return null;

  return {
    blocks: envelope.blocks.filter(function(data) {
      return data && typeof data === 'object';
    }),
    connections: Array.isArray(envelope.connections) ?
        envelope.connections :
        [],
    extras: envelope.extras && typeof envelope.extras === 'object' ?
        envelope.extras :
        null,
  };
};

/**
 * @param {!Object} buffer The buffer read off the clipboard, to be this page's.
 */
export const takeClipboardBuffer = function(buffer) {
  copyData.clear();
  buffer.blocks.forEach(function(data) {
    copyData.add(JSON.stringify(data));
  });

  connectionDBList.length = 0;
  buffer.connections.forEach(function(pair) {
    connectionDBList.push(pair);
  });

  setCopyExtras(buffer.extras);
};

/**
 * The clipboard through a selection nobody sees, for where the asynchronous
 * one is refused: inside a frame of another origin that is the policy of the
 * embedder to decide, and the copy has to happen either way.
 * @param {string} text The text to put on the clipboard.
 */
const writeThroughSelection = function(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');

  // Out of sight, but part of the page: a selection of what is not rendered is
  // not a selection at all.
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  document.body.appendChild(area);

  const active = document.activeElement;
  try {
    area.select();
    document.execCommand('copy');
  } catch (e) {
    // Nothing else to try; the buffer of the page still holds what was copied.
  }
  document.body.removeChild(area);

  // The shortcuts of the editor reach the workspace only while it is focused,
  // and a copy is rarely the last thing a user does.
  if (active && typeof active.focus === 'function') active.focus();
};

/**
 * Whether the asynchronous clipboard is offered here at all. Inside a frame it
 * is the embedder's to allow, and asking anyway is a violation the console
 * reports on every copy - the selection below is refused nothing.
 * @param {string} feature The permission to look for.
 * @returns {boolean} Whether this document is allowed it.
 */
const allowedHere = function(feature) {
  const policy = document.permissionsPolicy || document.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== 'function') return true;

  try {
    return policy.allowsFeature(feature);
  } catch (e) {
    return true;
  }
};

/**
 * @param {string} text The text to put on the clipboard of the system.
 */
export const writeClipboardText = function(text) {
  if (!navigator.clipboard || !navigator.clipboard.writeText ||
      !allowedHere('clipboard-write')) {
    writeThroughSelection(text);
    return;
  }

  try {
    navigator.clipboard.writeText(text).catch(function() {
      writeThroughSelection(text);
    });
  } catch (e) {
    writeThroughSelection(text);
  }
};

/**
 * Reading is what a browser guards: the paste event is handed the text, and
 * anywhere else it is asked for. A refusal is an answer like any other.
 * @returns {!Promise<?string>} The text on the clipboard, if it can be read.
 */
export const readClipboardText = function() {
  if (!navigator.clipboard || !navigator.clipboard.readText ||
      !allowedHere('clipboard-read')) {
    return Promise.resolve(null);
  }

  try {
    return navigator.clipboard.readText().catch(function() {
      return null;
    });
  } catch (e) {
    return Promise.resolve(null);
  }
};
