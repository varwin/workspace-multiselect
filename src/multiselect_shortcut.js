/**
 * @license
 * Copyright 2022 MIT
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Multiple selection shortcut.
 */

import * as Blockly from 'blockly/core';
import {
  dragSelectionWeakMap, hasSelectedParent, copyData, connectionDBList,
  dataCopyToStorage, dataCopyFromStorage, registeredShortcut,
  multiDraggableWeakMap, inPasteShortcut, getByID, shortcutNames,
  getCopyPasteHook, setCopyExtras, getCopyExtras,
} from './global';
import {
  buildClipboardText, parseClipboardText, readClipboardText,
  takeClipboardBuffer, useSystemClipboard, writeClipboardText,
} from './system_clipboard';
import {MultiselectDraggable} from './multiselect_draggable';

/**
 * Modification for keyboard shortcut 'Delete' to be available
 * for multiple blocks.
 */
const registerShortcutDelete = function() {
  const name = shortcutNames.MULTIDELETE;
  const deleteShortcut = {
    name,
    preconditionFn: function(workspace) {
      if (workspace.options.readOnly || Blockly.Gesture.inProgress()) {
        return false;
      }
      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      if (!dragSelection.size) {
        return deleteShortcut.check(selected);
      }
      for (const id of dragSelection) {
        const element = getByID(workspace, id);
        if (deleteShortcut.check(element)) {
          return true;
        }
      }
      return false;
    },
    check: function(element) {
      if (element instanceof Blockly.BlockSvg) {
        return element && element.isDeletable() &&
            !element.workspace.isFlyout &&
            !hasSelectedParent(element);
      } else if (element instanceof
          Blockly.comments.RenderedWorkspaceComment) {
        return element && element.isDeletable();
      }
      return false;
    },
    callback: function(workspace, e) {
      // Delete or backspace.
      // Stop the browser from going back to the previous page.
      // Do this first to prevent an error in the delete code from resulting in
      // data loss.
      e.preventDefault();

      const apply = function(element) {
        if (deleteShortcut.check(element)) {
          element.workspace.hideChaff();
          if (element instanceof Blockly.BlockSvg) {
            if (element.outputConnection) {
              element.dispose(false, true);
            } else {
              element.dispose(true, true);
            }
          } else {
            element.dispose();
          }
        }
      };

      const selected = Blockly.common.getSelected();
      Blockly.Events.setGroup(true);
      const dragSelection = dragSelectionWeakMap.get(workspace);

      // Handle the case where MultiselectDraggable is in use
      if (selected && selected instanceof MultiselectDraggable) {
        for (const element of selected.subDraggables) {
          selected.removeSubDraggable_(element[0]);
          apply(element[0]);
        }
        dragSelection.clear();
      } else if (!dragSelection.size) {
        apply(selected);
      }

      Blockly.Events.setGroup(false);
      return true;
    },
  };
  if (name in Blockly.ShortcutRegistry.registry.getRegistry()) {
    Blockly.ShortcutRegistry.registry.unregister(name);
  }
  Blockly.ShortcutRegistry.registry.register(deleteShortcut);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      Blockly.utils.KeyCodes.DELETE, deleteShortcut.name, true);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      Blockly.utils.KeyCodes.BACKSPACE, deleteShortcut.name, true);
};


/**
 * Keyboard shortcut to copy multiple selected blocks on
 * ctrl+c, cmd+c, or alt+c.
 * @param {boolean} useCopyPasteCrossTab Whether or not to use copy/paste
 */
const registerCopy = function(useCopyPasteCrossTab) {
  const name = shortcutNames.MULTICOPY;
  const copyShortcut = {
    name,
    preconditionFn: function(workspace) {
      if (workspace.options.readOnly || Blockly.Gesture.inProgress()) {
        return false;
      }
      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      if (!dragSelection.size) {
        return copyShortcut.check(selected);
      }
      for (const id of dragSelection) {
        const element = getByID(workspace, id);
        if (copyShortcut.check(element)) {
          return true;
        }
      }
      return false;
    },
    check: function(element) {
      if (element instanceof Blockly.BlockSvg) {
        return element && element.isDeletable() && element.isMovable() &&
            !hasSelectedParent(element);
      } else if (element instanceof
          Blockly.comments.RenderedWorkspaceComment) {
        return element && element.isDeletable() && element.isMovable();
      }
      return false;
    },
    callback: function(workspace, e) {
      // Prevent the default copy behavior, which may beep or
      // otherwise indicate an error due to the lack of a selection.
      e.preventDefault();
      copyData.clear();
      workspace.hideChaff();
      const blockList = [];
      const apply = function(element) {
        if (copyShortcut.check(element)) {
          copyData.add(JSON.stringify({ ...element.toCopyData(), workspaceId: workspace.id }));
          if (element instanceof Blockly.BlockSvg) {
            blockList.push(element.id);
          }
        }
      };
      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);

      // Handle the case where MultiselectDraggable is in use
      if (selected && selected instanceof MultiselectDraggable) {
        for (const element of selected.subDraggables) {
          apply(element[0]);
        }
      } else if (!dragSelection.size) {
        apply(selected);
      }

      connectionDBList.length = 0;
      blockList.forEach(function(id) {
        const block = workspace.getBlockById(id);
        const parentBlock = block.getParent();
        if (parentBlock && blockList.indexOf(parentBlock.id) !== -1 &&
            parentBlock.getNextBlock() === block) {
          connectionDBList.push([
            blockList.indexOf(parentBlock.id),
            blockList.indexOf(block.id)]);
        }
      });
      // Before the transport rather than after it: what the hooks add to the
      // buffer travels with it.
      const afterCopy = getCopyPasteHook(workspace, 'afterCopy');
      setCopyExtras(afterCopy ? afterCopy(workspace, {
        blocks: Array.from(copyData).map(function(stringData) {
          return JSON.parse(stringData);
        }),
        connections: connectionDBList.slice(),
      }) : null);

      if (useSystemClipboard()) {
        writeClipboardText(buildClipboardText(getCopyExtras()));
      } else if (useCopyPasteCrossTab) {
        dataCopyToStorage();
      }

      Blockly.Events.setGroup(false);
      return true;
    },
  };
  if (name in Blockly.ShortcutRegistry.registry.getRegistry()) {
    Blockly.ShortcutRegistry.registry.unregister(name);
  }
  Blockly.ShortcutRegistry.registry.register(copyShortcut);

  const ctrlC = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.C, [Blockly.utils.KeyCodes.CTRL]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      ctrlC, copyShortcut.name, true);

  const altC = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.C, [Blockly.utils.KeyCodes.ALT]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      altC, copyShortcut.name, true);

  const metaC = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.C, [Blockly.utils.KeyCodes.META]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      metaC, copyShortcut.name, true);
};


/**
 * Keyboard shortcut to copy and delete multiple selected blocks on
 * ctrl+x, cmd+x, or alt+x.
 * @param {boolean} useCopyPasteCrossTab Whether or not to use copy/paste
 */
const registerCut = function(useCopyPasteCrossTab) {
  const name = shortcutNames.MULTICUT;
  const cutShortcut = {
    name,
    preconditionFn: function(workspace) {
      if (workspace.options.readOnly || Blockly.Gesture.inProgress()) {
        return false;
      }
      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      if (!dragSelection.size) {
        return cutShortcut.check(selected);
      }
      for (const id of dragSelection) {
        const element = getByID(workspace, id);
        if (cutShortcut.check(element)) {
          return true;
        }
      }
      return false;
    },
    check: function(element) {
      if (element instanceof Blockly.BlockSvg) {
        return element && element.isDeletable() && element.isMovable() &&
            !element.workspace.isFlyout &&
            !hasSelectedParent(element);
      } else if (element instanceof
          Blockly.comments.RenderedWorkspaceComment) {
        return element && element.isDeletable() && element.isMovable();
      }
      return false;
    },
    callback: function(workspace) {
      copyData.clear();
      const elementList = [];
      const apply = function(element) {
        if (cutShortcut.check(element)) {
          copyData.add(JSON.stringify({...element.toCopyData(), workspaceId: workspace.id}));
          elementList.push(element.id);
        }
      };
      const applyDelete = function(element) {
        if (!element) return;
        element.workspace.hideChaff();
        if (element instanceof Blockly.BlockSvg) {
          if (element.outputConnection) {
            element.dispose(false, true);
          } else {
            element.dispose(true, true);
          }
        } else {
          // This may need to be adjusted based on what
          // kinds of draggables are added to blockly
          element.dispose();
        }
      };

      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);

      // Handle the case where MultiselectDraggable is in use
      if (selected && selected instanceof MultiselectDraggable) {
        for (const element of selected.subDraggables) {
          apply(element[0]);
          selected.removeSubDraggable_(element[0]);
        }
      } else if (!dragSelection.size) {
        apply(selected);
      }
      dragSelection.clear();

      connectionDBList.length = 0;
      elementList.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (block) {
          const parentBlock = block.getParent();
          if (parentBlock && elementList.indexOf(parentBlock.id) !== -1 &&
              parentBlock.getNextBlock() === block) {
            connectionDBList.push([
              elementList.indexOf(parentBlock.id),
              elementList.indexOf(block.id)]);
          }
        }
      });
      elementList.forEach(function(id) {
        const element = getByID(workspace, id);
        applyDelete(element);
      });

      // Before the transport rather than after it: what the hooks add to the
      // buffer travels with it.
      const afterCopy = getCopyPasteHook(workspace, 'afterCopy');
      setCopyExtras(afterCopy ? afterCopy(workspace, {
        blocks: Array.from(copyData).map(function(stringData) {
          return JSON.parse(stringData);
        }),
        connections: connectionDBList.slice(),
      }) : null);

      if (useSystemClipboard()) {
        writeClipboardText(buildClipboardText(getCopyExtras()));
      } else if (useCopyPasteCrossTab) {
        dataCopyToStorage();
      }

      Blockly.Events.setGroup(false);
      return true;
    },
  };

  if (name in Blockly.ShortcutRegistry.registry.getRegistry()) {
    Blockly.ShortcutRegistry.registry.unregister(name);
  }
  Blockly.ShortcutRegistry.registry.register(cutShortcut);

  const ctrlX = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.X, [Blockly.utils.KeyCodes.CTRL]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      ctrlX, cutShortcut.name, true);

  const altX = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.X, [Blockly.utils.KeyCodes.ALT]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      altX, cutShortcut.name, true);

  const metaX = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.X, [Blockly.utils.KeyCodes.META]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      metaX, cutShortcut.name, true);
};

/**
 * How long the paste event of a shortcut is waited for before the clipboard is
 * read for the text it would have carried.
 */
const PASTE_EVENT_TIMEOUT = 200;

/**
 * The paste a shortcut asked for, until the event the browser fires for it
 * arrives.
 */
let expectedPaste = null;

/**
 * The paste event is the page's, as the shortcuts reading it are, and is
 * listened for once.
 */
let listeningForPaste = false;

/**
 * @param {!Blockly.Workspace} workspace The workspace to paste on.
 * @returns {boolean} Whether the paste was carried out.
 */
export const pasteBuffer = function(workspace) {
  const dragSelection = dragSelectionWeakMap.get(workspace);
  const multiDraggable = multiDraggableWeakMap.get(workspace);

  // A paste of the page reaches here whichever workspace it found, and one
  // the plugin was disposed of holds nothing to paste onto.
  if (!dragSelection || !multiDraggable) return false;

  inPasteShortcut.set(workspace, true);

  // Update the dragSelection and multiDraggable object
  // to remove current selection prior to pasting.
  if (dragSelection.size) {
    dragSelection.forEach(function(id) {
      const element = getByID(workspace, id);
      if (element) {
        element.unselect();
      }
    });
    dragSelection.clear();
    multiDraggable.clearAll_();
  }

  // A paste can be a step inside something larger: an already open group is
  // the one everything pasted here belongs to.
  const outerGroup = Blockly.Events.getGroup();
  if (!outerGroup) {
    Blockly.Events.setGroup(true);
  }

  const blockList = [];

  const beforePaste = getCopyPasteHook(workspace, 'beforePaste');
  if (beforePaste) {
    beforePaste(workspace, getCopyExtras());
  }

  let pasteBlocks = Array.from(copyData).map(function(stringData) {
    return JSON.parse(stringData);
  });
  let pasteConnections = connectionDBList.slice();

  // What was copied is about the workspace it was copied on, down to the
  // id it is stamped with. A hook is what lets another one take it as its
  // own - the stash itself stays as it was copied, since it belongs to
  // every workspace reading it.
  const adaptPaste = getCopyPasteHook(workspace, 'adaptPaste');
  if (adaptPaste) {
    const adapted = adaptPaste(workspace, {
      blocks: pasteBlocks,
      connections: pasteConnections,
    });
    if (adapted) {
      pasteBlocks = adapted.blocks || [];
      pasteConnections = adapted.connections || [];
    }
  }

  pasteBlocks.forEach(function(data) {
    if (data.workspaceId !== workspace.id) {
      return;
    }
    // Set unique id for data to prevent bug where
    // blocks on multiple workspaces are highlighted.
    if (workspace.id !== Blockly.getMainWorkspace().id) {
      if (data.blockState) {
        data.blockState.id = Blockly.utils.idGenerator.genUid();
      } else if (data.commentState) {
        data.commentState.id = Blockly.utils.idGenerator.genUid();
      }
    }

    if (data.source) {
      workspace = data.source;
    }
    if (workspace.isFlyout) {
      workspace = workspace.targetWorkspace;
    }
    if (data.typeCounts &&
        workspace.isCapacityAvailable(data.typeCounts)) {
      const element = Blockly.clipboard.paste(data, workspace);
      if (element) {
        blockList.push(element);
      }
      if (element.type !== 'drag_to_dupe') {
        dragSelectionWeakMap.get(workspace).add(element.id);
        multiDraggableWeakMap.get(workspace).addSubDraggable_(element);
      }
    } else if (data.commentState) {
      const element = Blockly.clipboard.paste(data, workspace);
      if (element) {
        element.select();
      }
      dragSelectionWeakMap.get(workspace).add(element.id);
      multiDraggableWeakMap.get(workspace).addSubDraggable_(element);
    }
  });
  pasteConnections.forEach(function(connectionDB) {
    blockList[connectionDB[0]].nextConnection.connect(
        blockList[connectionDB[1]].previousConnection);
  });

  // The elements are the ones this paste added, top level only.
  const afterPaste = getCopyPasteHook(workspace, 'afterPaste');
  if (afterPaste) {
    afterPaste(workspace, blockList);
  }

  Blockly.common.setSelected(multiDraggable);
  if (!outerGroup) {
    Blockly.Events.setGroup(false);
  }
  return true;
};

/**
 * The browser answers a paste shortcut with an event carrying the text, which
 * is the one place the clipboard is handed over rather than asked for. Where
 * the page is not told about the paste at all - an editor inside a frame of
 * another origin, a paste carried out by the application around it - nothing
 * arrives, and the clipboard is read for it instead.
 * @param {!Blockly.Workspace} workspace The workspace to paste on.
 */
const expectPasteEvent = function(workspace) {
  const expected = {workspace: workspace};
  expectedPaste = expected;

  setTimeout(function() {
    if (expectedPaste !== expected) return;
    expectedPaste = null;

    readClipboardText().then(function(text) {
      const buffer = parseClipboardText(text);
      if (!buffer) return;

      takeClipboardBuffer(buffer);
      pasteBuffer(workspace);
    });
  }, PASTE_EVENT_TIMEOUT);
};

/**
 * A paste of the page, however it was asked for: by the shortcut, by the menu
 * of the browser, by the application around it.
 * @param {!ClipboardEvent} e The event as it arrived.
 */
const onPaste = function(e) {
  if (!useSystemClipboard()) return;

  const expected = expectedPaste;
  expectedPaste = null;

  // A field being edited is pasting text into itself.
  if (Blockly.browserEvents.isTargetInput(e) || !e.clipboardData) return;

  const buffer = parseClipboardText(e.clipboardData.getData('text/plain'));
  if (!buffer) return;

  // A paste that came some other way than the shortcut goes to the workspace
  // Blockly itself would hand one.
  const workspace = (expected && expected.workspace) ||
      Blockly.common.getMainWorkspace();
  if (!workspace || workspace.options.readOnly ||
      Blockly.Gesture.inProgress()) {
    return;
  }

  e.preventDefault();
  takeClipboardBuffer(buffer);
  pasteBuffer(workspace);
};

const listenForPasteEvents = function() {
  if (listeningForPaste) return;

  listeningForPaste = true;
  document.addEventListener('paste', onPaste);
};

// TODO: Look into undo stack and adding/removing blocks from multidraggable
/**
 * Keyboard shortcut to paste multiple selected blocks on
 * ctrl+v, cmd+v, or alt+v.
 * @param {boolean} useCopyPasteCrossTab Whether or not to use copy/paste
 */
const registerPaste = function(useCopyPasteCrossTab) {
  const name = shortcutNames.MULTIPASTE;
  const pasteShortcut = {
    name,
    preconditionFn: function(workspace) {
      return !workspace.options.readOnly && !Blockly.Gesture.inProgress();
    },
    callback: function(workspace) {
      if (useSystemClipboard()) {
        expectPasteEvent(workspace);
        return true;
      }

      if (useCopyPasteCrossTab) {
        dataCopyFromStorage();
      }

      return pasteBuffer(workspace);
    },
  };

  if (name in Blockly.ShortcutRegistry.registry.getRegistry()) {
    Blockly.ShortcutRegistry.registry.unregister(name);
  }
  Blockly.ShortcutRegistry.registry.register(pasteShortcut);

  const ctrlV = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.V, [Blockly.utils.KeyCodes.CTRL]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      ctrlV, pasteShortcut.name, true);

  const altV = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.V, [Blockly.utils.KeyCodes.ALT]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      altV, pasteShortcut.name, true);

  const metaV = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.V, [Blockly.utils.KeyCodes.META]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      metaV, pasteShortcut.name, true);

  listenForPasteEvents();
};

/**
 * Keyboard shortcut to duplicate multiple selected blocks on
 * ctrl+d.
 */
const registerDuplicate = function() {
  const name = shortcutNames.MULTIDUPLICATE;
  const duplicateShortcut = {
    name,
    preconditionFn: function(workspace) {
      if (workspace.options.readOnly || Blockly.Gesture.inProgress()) {
        return false;
      }
      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      if (!dragSelection.size) {
        return duplicateShortcut.check(selected);
      }
      for (const id of dragSelection) {
        const element = getByID(workspace, id);
        if (duplicateShortcut.check(element)) {
          return true;
        }
      }
      return false;
    },
    check: function(element) {
      if (element instanceof Blockly.BlockSvg) {
        return element && element.isDeletable() && element.isMovable() &&
          !hasSelectedParent(element);
      } else if (element instanceof
        Blockly.comments.RenderedWorkspaceComment) {
        return element && element.isDeletable() && element.isMovable();
      }
      return false;
    },
    callback: function(workspace, e) {
      e.preventDefault();
      workspace.hideChaff();

      const duplicatedBlocks = {};
      const connectionDBList = [];
      const multiDraggable = multiDraggableWeakMap.get(workspace);

      const apply = function(block) {
        if (duplicateShortcut.check(block)) {
          // Generate a new unique ID
          const newId = Blockly.utils.idGenerator.genUid();
          // Get the copy data of the block
          const blockCopyData = block.toCopyData();
          // Set the new ID in the copy data
          blockCopyData.blockState.id = newId;
          // Paste the block with the modified copy data
          duplicatedBlocks[block.id] =
            Blockly.clipboard.paste(blockCopyData, workspace);
        }
      };

      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);

      // Handle the case where MultiselectDraggable is in use
      if (selected && selected instanceof MultiselectDraggable) {
        for (const element of selected.subDraggables) {
          apply(element[0]);
        }
      } else if (!dragSelection.size) {
        apply(selected);
      }

      dragSelection.clear();
      multiDraggable.clearAll_();
      Blockly.common.setSelected(null);

      for (const [id, block] of Object.entries(duplicatedBlocks)) {
        const origBlock = workspace.getBlockById(id);
        const origParentBlock = origBlock.getParent();
        if (block.id) {
          if (origParentBlock && origParentBlock.id in duplicatedBlocks &&
            origParentBlock.getNextBlock() === origBlock) {
            connectionDBList.push([
              duplicatedBlocks[origParentBlock.id].nextConnection,
              block.previousConnection]);
          }
          if (block.type !== 'drag_to_dupe') {
            dragSelection.add(block.id);
            multiDraggable.addSubDraggable_(block);
          }
        }
      }
      connectionDBList.forEach(function(connectionDB) {
        connectionDB[0].connect(connectionDB[1]);
      });
      Blockly.common.setSelected(multiDraggable);
      Blockly.Events.setGroup(false);

      return true;
    }
  };

  if (name in Blockly.ShortcutRegistry.registry.getRegistry()) {
    Blockly.ShortcutRegistry.registry.unregister(name);
  }
  Blockly.ShortcutRegistry.registry.register(duplicateShortcut);

  const ctrlD = Blockly.ShortcutRegistry.registry.createSerializedKey(
    Blockly.utils.KeyCodes.D, [Blockly.utils.KeyCodes.CTRL]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
    ctrlD, duplicateShortcut.name, true);
};

/**
 * Keyboard shortcut to select all top blocks in the workspace on
 * ctrl+a, cmd+a, or alt+a.
 */
const registerSelectAll = function() {
  const name = 'selectall';
  const selectAllShortcut = {
    name,
    preconditionFn: function(workspace) {
      return workspace.getTopBlocks(false, true).some(
          (b) => selectAllShortcut.check(b)) ? true : false;
    },
    check: function(block) {
      return block &&
            (block.isDeletable() || block.isMovable()) &&
            !block.isInsertionMarker();
    },
    callback: function(workspace, e) {
      // Prevent the default text all selection behavior.
      e.preventDefault();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      const multiDraggable = multiDraggableWeakMap.get(workspace);

      // Make sure that there is nothing in the multiDraggable
      // (clearing) prior to selecting all blocks in workspace.
      if (Blockly.getSelected()) {
        if (Blockly.getSelected() instanceof MultiselectDraggable) {
          for (const [subDraggable] of Blockly.getSelected().subDraggables) {
            subDraggable.unselect();
          }
        } else {
          Blockly.getSelected().unselect();
        }
        Blockly.common.setSelected(null);
        multiDraggable.clearAll_();
        dragSelectionWeakMap.get(workspace).clear();
      }

      const blockList = [];
      workspace.getTopBlocks(false, true).forEach(function(block) {
        if (selectAllShortcut.check(block)) {
          blockList.push(block);
          let nextBlock = block.getNextBlock();
          while (nextBlock) {
            blockList.push(nextBlock);
            nextBlock = nextBlock.getNextBlock();
          }
        }
      });
      blockList.forEach(function(block) {
        if (block.type !== 'drag_to_dupe') {
          multiDraggable.addSubDraggable_(block);
          dragSelection.add(block.id);
        }
      });

      Blockly.common.setSelected(multiDraggable);
      return true;
    },
  };
  if (name in Blockly.ShortcutRegistry.registry.getRegistry()) {
    Blockly.ShortcutRegistry.registry.unregister(name);
  }
  Blockly.ShortcutRegistry.registry.register(selectAllShortcut);

  const ctrlA = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.A, [Blockly.utils.KeyCodes.CTRL]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      ctrlA, selectAllShortcut.name);

  const altA =
  Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.A, [Blockly.utils.KeyCodes.ALT]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      altA, selectAllShortcut.name);

  const metaA = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.A, [Blockly.utils.KeyCodes.META]);
  Blockly.ShortcutRegistry.registry.addKeyMapping(
      metaA, selectAllShortcut.name);
};

/**
 * Unregister keyboard shortcut item, should be called before registering.
 */
export const unregisterOrigShortcut = function() {
  registeredShortcut.length = 0;
  for (const name of [
    Blockly.ShortcutItems.names.DELETE,
    Blockly.ShortcutItems.names.COPY,
    Blockly.ShortcutItems.names.CUT,
    Blockly.ShortcutItems.names.PASTE,
    Blockly.ShortcutItems.names.DUPLICATE]) {
    if (Object.entries(Blockly.ShortcutRegistry.registry.getRegistry())
      .map(([_, value]) => value.name).includes(name)) {
      Blockly.ShortcutRegistry.registry.unregister(name);
      registeredShortcut.push(name);
    }
  }
};

export const unregisterOurShortcut = function() {
  registeredShortcut.length = 0;
  for (const name of [
    shortcutNames.MULTIDELETE,
    shortcutNames.MULTICOPY,
    shortcutNames.MULTICUT,
    shortcutNames.MULTIPASTE,
    shortcutNames.MULTIDUPLICATE]) {
    if (Object.entries(Blockly.ShortcutRegistry.registry.getRegistry())
      .map(([_, value]) => value.name).includes(name)) {
      Blockly.ShortcutRegistry.registry.unregister(name);
    }
  }
  for (const name of [
    Blockly.ShortcutItems.names.DELETE,
    Blockly.ShortcutItems.names.COPY,
    Blockly.ShortcutItems.names.CUT,
    Blockly.ShortcutItems.names.PASTE,
    Blockly.ShortcutItems.names.DUPLICATE]) {
    registeredShortcut.push(name);
  }
};

/**
 * Register default keyboard shortcut item.
 */
export const registerOrigShortcut = function() {
  const map = {
    [Blockly.ShortcutItems.names.DELETE]: Blockly.ShortcutItems.registerDelete,
    [Blockly.ShortcutItems.names.COPY]: Blockly.ShortcutItems.registerCopy,
    [Blockly.ShortcutItems.names.CUT]: Blockly.ShortcutItems.registerCut,
    [Blockly.ShortcutItems.names.PASTE]: Blockly.ShortcutItems.registerPaste,
    [Blockly.ShortcutItems.names.DUPLICATE]: Blockly.ShortcutItems.registerDuplicate
  };
  for (const name of registeredShortcut) {
    map[name]();
  }
};

/**
 * Registers all modified keyboard shortcut item.
 * @param {boolean} useCopyPasteCrossTab Whether to use copy/paste cross tab.
 */
export const registerOurShortcut = function(useCopyPasteCrossTab) {
  const ListNoParameter = [Blockly.ShortcutItems.names.DELETE];
  const map = {
    [Blockly.ShortcutItems.names.DELETE]: registerShortcutDelete,
    [Blockly.ShortcutItems.names.COPY]: registerCopy,
    [Blockly.ShortcutItems.names.CUT]: registerCut,
    [Blockly.ShortcutItems.names.PASTE]: registerPaste,
    [Blockly.ShortcutItems.names.DUPLICATE]: registerDuplicate
  };
  for (const name of registeredShortcut) {
    if (ListNoParameter.includes(name)) {
      map[name]();
    } else {
      map[name](useCopyPasteCrossTab);
    }
  }
  registerSelectAll();
};
