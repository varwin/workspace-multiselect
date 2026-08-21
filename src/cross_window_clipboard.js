/**
 * @license
 * Copyright 2025 Varwin
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Taking a buffer copied on another workspace as this one's.
 *
 * The buffer already travels between windows: with crossTab on it is written to
 * localStorage, and windows of the same origin share it. What it carries,
 * though, is about the workspace it was copied on - it is stamped with that
 * workspace, and a paste keeps only what matches the one pasting it.
 *
 * On top of that, a workspace of the varwin-blockly fork holds blocks that know
 * the module they live in and the signature of the definition they were built
 * from. The module belongs to the other scene, and a signature is how the
 * editor rebuilds a block whose type a scene no longer has, marking what it
 * restores as removed. So the definitions behind the copied signatures travel
 * with the buffer, and a block of an object this scene never had arrives the
 * same as a block of an object it lost.
 *
 * All of it is optional: a workspace without those methods simply gets the
 * blocks it can build.
 */

import * as Blockly from 'blockly/core';

/**
 * The keys this module keeps alongside the buffer of the plugin itself.
 */
const STASH_DEFINITIONS = 'varwinBlocklyStashDefinitions';
const STASH_PROCEDURES = 'varwinBlocklyStashProcedures';

/**
 * The field naming the object instance a block acts on.
 */
const INSTANCE_FIELD = 'instance';

/**
 * A call carries the name of its function and nothing else: pasted where no
 * such function exists, Blockly writes an empty one to call.
 */
const CALL_TYPES = [
  'procedures_callnoreturn',
  'procedures_callreturn',
  'procedures_with_argument_callnoreturn',
  'procedures_with_argument_callreturn',
];

/**
 * A function can be copied along with a call of it, and then it travels twice:
 * with the blocks, and in the stash the call put it in. The one from the stash
 * is pasted first, so the copy among the blocks is the one left behind.
 */
const DEFINITION_TYPES = [
  'procedures_defnoreturn',
  'procedures_defreturn',
  'procedures_with_argument_defnoreturn',
  'procedures_with_argument_defreturn',
];

/**
 * Kept for as long as the undo history can reach back to a paste, which
 * outlasts the buffer they came from.
 */
const broughtDefinitions = new Map();

/**
 * A type of another scene is known by its signature alone, so the definition
 * behind it has to outlive the blocks: undo takes the last of them, and redo
 * asks for the type back.
 */
const protectedSignatures = new Set();

/**
 * Read one of our own keys.
 * @param {string} key The key to read.
 * @returns {!Object} What was stored, or an empty object.
 */
const readJson = function(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch (e) {
    return {};
  }
};

/**
 * Visit the places a block state holds another one.
 * @param {?Object} state The state to walk.
 * @param {!Function} visit Called with the holder and the key to look at.
 */
const eachChildState = function(state, visit) {
  if (!state || typeof state !== 'object') return;

  if (state.inputs) {
    Object.keys(state.inputs).forEach(function(name) {
      const input = state.inputs[name];
      if (!input) return;
      visit(input, 'block');
      visit(input, 'shadow');
    });
  }

  if (state.next) {
    visit(state.next, 'block');
    visit(state.next, 'shadow');
  }
};

/**
 * Collect the signatures a block state was built from, its children included.
 * @param {?Object} state The state to walk.
 * @param {!Set<string>} signatures The signatures found so far.
 */
const collectSignatures = function(state, signatures) {
  if (!state || typeof state !== 'object') return;

  if (state.signature) signatures.add(state.signature);

  eachChildState(state, function(holder, key) {
    collectSignatures(holder[key], signatures);
  });
};

/**
 * Where the name sits differs between the stock call blocks and the ones
 * taking local arguments, so both places are read.
 * @param {?Object} state The state of a block.
 * @returns {?string} The name of the function called, if it is a call at all.
 */
const procedureNameOf = function(state) {
  if (!state || CALL_TYPES.indexOf(state.type) === -1) return null;

  if (state.extraState && state.extraState.name) return state.extraState.name;
  if (state.fields && state.fields.NAME) return state.fields.NAME;

  return null;
};

/**
 * The name a definition block gives its function.
 * @param {?Object} state The state of a block.
 * @returns {?string} The name, if the block defines a function at all.
 */
const definitionNameOf = function(state) {
  if (!state || DEFINITION_TYPES.indexOf(state.type) === -1) return null;

  if (state.extraState && state.extraState.name) return state.extraState.name;
  if (state.fields && state.fields.NAME) return state.fields.NAME;

  return null;
};

/**
 * Collect the functions a block state calls, its children included.
 * @param {?Object} state The state to walk.
 * @param {!Set<string>} names The names found so far.
 */
const collectProcedureNames = function(state, names) {
  if (!state || typeof state !== 'object') return;

  const name = procedureNameOf(state);
  if (name) names.add(name);

  eachChildState(state, function(holder, key) {
    collectProcedureNames(holder[key], names);
  });
};

/**
 * The block states of a buffer, the entries holding none left out.
 * @param {!Object} buffer The buffer as the plugin holds it.
 * @returns {!Array<!Object>} The block states in it.
 */
const blockStatesOf = function(buffer) {
  return (buffer.blocks || [])
      .map(function(data) {
        return data && data.blockState;
      })
      .filter(Boolean);
};

/**
 * The definition a signature was registered with, on a workspace that keeps
 * them at all.
 * @param {!Blockly.Workspace} workspace The workspace to ask.
 * @param {?string} signature The signature to look up.
 * @returns {?Object} The definition, if this workspace has it.
 */
const definitionBySignature = function(workspace, signature) {
  if (!signature ||
      typeof workspace.getBlockDefinitionBySignature !== 'function') {
    return null;
  }

  return workspace.getBlockDefinitionBySignature(signature);
};

/**
 * A type this scene never registered has no generator either, and the code can
 * be asked for on screen even while the removed gate holds the save back.
 * @param {!Blockly.Workspace} workspace The workspace pasting the block.
 * @param {!Object} state The state of the block.
 * @param {?Object} generator The generator to write the empty code into.
 */
const ensureGenerator = function(workspace, state, generator) {
  if (!generator || !generator.forBlock) return;
  if (Blockly.Blocks[state.type] || generator.forBlock[state.type]) return;

  const definition = definitionBySignature(workspace, state.signature);
  const order = generator.Order ? generator.Order.ATOMIC : 0;

  generator.forBlock[state.type] =
      definition && definition.output !== undefined ?
          function() {
            return ['None', order];
          } :
          function() {
            return '';
          };
};

/**
 * The paste is not the place to find out a block cannot be built - Blockly
 * throws there and the whole paste is lost. What this workspace can build
 * neither by type nor by signature is cut out beforehand.
 * @param {!Blockly.Workspace} workspace The workspace pasting the block.
 * @param {?Object} state The state of the block.
 * @param {?Object} generator The generator of the host, if it has one.
 * @returns {boolean} Whether the block can be built here.
 */
const prepareState = function(workspace, state, generator) {
  if (!state || typeof state !== 'object' || !state.type) return false;

  if (!Blockly.Blocks[state.type] &&
      !definitionBySignature(workspace, state.signature)) {
    return false;
  }

  ensureGenerator(workspace, state, generator);

  // Without a module of its own the block joins the one being looked at.
  delete state.module;

  // Two scenes of one project can hold blocks of the same id, and a paste that
  // keeps them would collide with what is already on this workspace.
  delete state.id;

  eachChildState(state, function(holder, key) {
    if (holder[key] && !prepareState(workspace, holder[key], generator)) {
      delete holder[key];
    }
  });

  return true;
};

/**
 * The instance ids belong to the scene the blocks were copied from, so in this
 * one they name nothing - the first instance this scene does have takes over.
 * @param {!Array<!Object>} roots The blocks the paste added.
 */
const repairInstanceFields = function(roots) {
  roots.forEach(function(root) {
    if (!root || typeof root.getDescendants !== 'function') return;

    root.getDescendants(false).forEach(function(block) {
      const field = block.getField(INSTANCE_FIELD);
      if (!field || typeof field.getOptions !== 'function') return;

      const options = field.getOptions(false) || [];
      if (!options.length) return;

      const values = options.map(function(option) {
        return option[1];
      });
      if (values.includes(field.getValue())) return;

      field.setValue(values[0]);
    });
  });
};

/**
 * A called function travels whole, body and all - otherwise the other window
 * gets the empty one Blockly writes to satisfy the call. A body can call
 * further functions, so the names are followed as they are found.
 * @param {!Blockly.Workspace} workspace The workspace copied from.
 * @param {!Array<!Object>} states The block states copied.
 * @returns {!Object} The state of every function called, by name.
 */
const collectProcedures = function(workspace, states) {
  const names = new Set();
  states.forEach(function(state) {
    collectProcedureNames(state, names);
  });

  // A name is the user's to choose, so a plain object would answer for
  // `toString` and friends with what it inherits and drop the function.
  const procedures = Object.create(null);
  const pending = Array.from(names);

  while (pending.length) {
    const name = pending.shift();
    if (procedures[name]) continue;

    const definition = Blockly.Procedures.getDefinition(name, workspace);
    if (!definition) continue;

    // Ids are left out so the paste cannot collide with what the target scene
    // already has; the coordinates are kept so it lands where it was drawn.
    const state = Blockly.serialization.blocks.save(definition, {
      addCoordinates: true,
      saveIds: false,
    });
    if (!state) continue;

    procedures[name] = state;

    const nested = new Set();
    collectProcedureNames(state, nested);
    nested.forEach(function(nestedName) {
      pending.push(nestedName);
    });
  }

  return procedures;
};

/**
 * Copying is the plugin's; this only adds what the other window needs to
 * rebuild what it has never seen.
 * @param {!Blockly.Workspace} workspace The workspace copied from.
 * @param {!Object} buffer The buffer as it was copied.
 */
const stashCopy = function(workspace, buffer) {
  const states = blockStatesOf(buffer);
  const procedures = collectProcedures(workspace, states);

  const signatures = new Set();
  states.forEach(function(state) {
    collectSignatures(state, signatures);
  });
  Object.keys(procedures).forEach(function(name) {
    collectSignatures(procedures[name], signatures);
  });

  const registered =
      typeof workspace.getBlockDefinitionsBySignatures === 'function' ?
          workspace.getBlockDefinitionsBySignatures() :
          {};

  const definitions = {};
  signatures.forEach(function(signature) {
    if (registered[signature]) definitions[signature] = registered[signature];
  });

  localStorage.setItem(STASH_DEFINITIONS, JSON.stringify(definitions));
  localStorage.setItem(STASH_PROCEDURES, JSON.stringify(procedures));
};

/**
 * Before the blocks, so a call finds the real function rather than the empty
 * one Blockly would write for it. A function this scene already has keeps the
 * call.
 * @param {!Blockly.Workspace} workspace The workspace pasting.
 * @param {?Object} generator The generator of the host, if it has one.
 * @returns {!Object} The blocks this added, and the functions they define.
 */
const adoptProcedures = function(workspace, generator) {
  const procedures = readJson(STASH_PROCEDURES);
  const blocks = [];
  const names = new Set();

  Object.keys(procedures).forEach(function(name) {
    if (Blockly.Procedures.getDefinition(name, workspace)) return;

    const state = procedures[name];
    if (!prepareState(workspace, state, generator)) return;

    // Undo-able, and in the group the paste runs in: a function that arrived
    // with the blocks leaves with them.
    const block = Blockly.serialization.blocks.append(state, workspace, {
      recordUndo: true,
    });
    if (!block) return;

    blocks.push(block);
    names.add(name);
  });

  return {blocks: blocks, names: names};
};

/**
 * The connections are held as positions among the copied blocks, so a block
 * left behind moves everyone after it.
 * @param {!Array<!Array<number>>} connections The connections as copied.
 * @param {!Object} indexById The new position of every block kept.
 * @returns {!Array<!Array<number>>} The connections among the blocks kept.
 */
const reindexConnections = function(connections, indexById) {
  return connections
      .filter(function(pair) {
        return Array.isArray(pair) && pair.length >= 2;
      })
      .map(function(pair) {
        return [indexById[pair[0]], indexById[pair[1]]];
      })
      .filter(function(pair) {
        return pair[0] !== undefined && pair[1] !== undefined;
      });
};

/**
 * Whether the buffer was copied somewhere else. A copy of this very workspace
 * is already about it, and pastes exactly as it was copied.
 * @param {!Blockly.Workspace} workspace The workspace pasting.
 * @param {!Object} buffer The buffer as it was read.
 * @returns {boolean} Whether anything in it came from another workspace.
 */
const isForeignBuffer = function(workspace, buffer) {
  return (buffer.blocks || []).some(function(data) {
    return data && data.workspaceId !== workspace.id;
  });
};

/**
 * What was read is about the window that copied it: stamped with that
 * workspace, held in a module of that scene, and built from types this one may
 * never have had.
 *
 * The stored buffer stays as it was copied - it belongs to every window, and
 * one of them narrowing it to what its own workspace can build would take
 * those blocks from all the others. Only what this paste uses is adapted.
 * @param {!Blockly.Workspace} workspace The workspace pasting.
 * @param {!Object} buffer The buffer as it was read.
 * @param {?Object} generator The generator of the host, if it has one.
 * @param {!Set<string>} brought The functions already pasted from the stash.
 * @returns {?Object} What to paste instead, or null to paste it as it is.
 */
const adoptBuffer = function(workspace, buffer, generator, brought) {
  const blocks = buffer.blocks || [];
  const adopted = [];
  const indexById = {};
  let copiedBlocks = 0;
  let keptBlocks = 0;

  blocks.forEach(function(data) {
    if (!data) return;

    if (data.blockState) {
      const wasAt = copiedBlocks++;

      // The function is already here, pasted from the stash before the blocks;
      // this copy of it would only be a second one under a made-up name.
      const defines = definitionNameOf(data.blockState);
      if (defines && brought.has(defines)) return;

      if (!prepareState(workspace, data.blockState, generator)) return;
      indexById[wasAt] = keptBlocks++;
    }

    data.workspaceId = workspace.id;
    adopted.push(data);
  });

  return {
    blocks: adopted,
    connections: reindexConnections(buffer.connections || [], indexById),
  };
};

/**
 * Registering them is what lets Blockly rebuild a block whose type this
 * workspace does not have - and, on the varwin-blockly fork, what makes it
 * call the result removed.
 *
 * A scene saves the definitions it holds, so the ones nothing was built from
 * are taken back out rather than left to be written into it.
 * @param {!Blockly.Workspace} workspace The workspace pasting.
 * @param {!Object} definitions The definitions that came with the buffer.
 * @returns {!Function} Releases the definitions nothing was built from.
 */
const installDefinitions = function(workspace, definitions) {
  if (typeof workspace.registerBlockDefinitions !== 'function') {
    return function() {};
  }

  const known =
      typeof workspace.getBlockDefinitionsBySignatures === 'function' ?
          workspace.getBlockDefinitionsBySignatures() :
          {};

  const added = Object.keys(definitions).filter(function(signature) {
    return !known[signature];
  });
  if (!added.length) return function() {};

  workspace.registerBlockDefinitions(definitions);

  return function() {
    if (typeof workspace.unregisterBlockDefinition !== 'function') return;

    const used = new Set(workspace.getAllBlocks(false).map(function(block) {
      return block.signature;
    }));
    added.forEach(function(signature) {
      if (used.has(signature)) {
        protectedSignatures.add(signature);
      } else {
        workspace.unregisterBlockDefinition(signature);
      }
    });
  };
};

/**
 * Blockly drops a definition with the last block holding its signature, which
 * is exactly what undoing a paste does.
 * @param {!Blockly.Workspace} workspace The workspace to guard.
 */
const guardDefinitions = function(workspace) {
  if (workspace.crossWindowDefinitionsGuarded) return;
  if (typeof workspace.unregisterBlockDefinition !== 'function') return;

  workspace.crossWindowDefinitionsGuarded = true;
  const unregister = workspace.unregisterBlockDefinition;

  workspace.unregisterBlockDefinition = function(signature) {
    if (protectedSignatures.has(signature)) return false;

    return unregister.call(this, signature);
  };
};

/**
 * Register the definitions that came with the buffer.
 * @param {!Blockly.Workspace} workspace The workspace pasting.
 * @returns {!Function} Releases the definitions nothing was built from.
 */
const adoptDefinitions = function(workspace) {
  const definitions = readJson(STASH_DEFINITIONS);

  Object.keys(definitions).forEach(function(signature) {
    broughtDefinitions.set(signature, definitions[signature]);
  });

  return installDefinitions(workspace, definitions);
};

/**
 * Belt to the guard's braces, for a definition lost some other way. The buffer
 * is no help by then: it may have been copied over since.
 * @param {!Blockly.Workspace} workspace The workspace to guard.
 */
const guardRedo = function(workspace) {
  if (workspace.crossWindowRedoGuarded) return;

  workspace.crossWindowRedoGuarded = true;
  const undo = workspace.undo;

  workspace.undo = function(redo) {
    if (!redo || !broughtDefinitions.size) return undo.call(this, redo);

    const definitions = {};
    broughtDefinitions.forEach(function(definition, signature) {
      definitions[signature] = definition;
    });

    const release = installDefinitions(this, definitions);

    try {
      return undo.call(this, redo);
    } finally {
      release();
    }
  };
};

/**
 * The copy/paste hooks that make a buffer copied on another workspace fit this
 * one. Everything they do runs in the group of events the paste is recorded
 * as, so a paste and all it brought with it undo as one.
 * @param {!Blockly.Workspace} workspace The workspace to build the hooks for.
 * @param {boolean|Object} options The crossWindow option as it was given.
 * @returns {!Object} The hooks, to be stored for this workspace.
 */
export const crossWindowClipboardHooks = function(workspace, options) {
  const settings = typeof options === 'object' && options ? options : {};

  // The generator of the host, for the types it turns out not to have - read
  // when it is needed, since a host may install it after the plugin. The Python
  // one of the varwin-blockly fork is where it sits by default.
  const generatorOf = function() {
    return settings.generator || Blockly.Python || null;
  };

  guardDefinitions(workspace);
  guardRedo(workspace);

  let releaseDefinitions = null;
  let adoptedProcedures = [];

  // The definitions of another scene are held only for as long as the paste
  // needs them; a paste that never reached its end releases them on the next.
  const release = function() {
    if (!releaseDefinitions) return;

    const releasing = releaseDefinitions;
    releaseDefinitions = null;
    releasing();
  };

  return {
    afterCopy: function(pasteWorkspace, buffer) {
      stashCopy(pasteWorkspace, buffer);
    },

    beforePaste: function(pasteWorkspace) {
      release();

      releaseDefinitions = adoptDefinitions(pasteWorkspace);
    },

    adaptPaste: function(pasteWorkspace, buffer) {
      // Nothing of another workspace to fit: this one pastes its own copy as
      // it was copied, functions and all.
      if (!isForeignBuffer(pasteWorkspace, buffer)) return null;

      const generator = generatorOf();

      // The functions the calls need, ahead of the blocks calling them.
      const procedures = adoptProcedures(pasteWorkspace, generator);
      adoptedProcedures = procedures.blocks;

      return adoptBuffer(pasteWorkspace, buffer, generator, procedures.names);
    },

    afterPaste: function(pasteWorkspace, elements) {
      // The functions that arrived with the blocks are as new to this
      // workspace as the blocks themselves, instances and all.
      repairInstanceFields(adoptedProcedures.concat(elements || []));
      adoptedProcedures = [];

      release();
    },
  };
};
