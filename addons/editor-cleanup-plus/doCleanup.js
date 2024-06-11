import UndoGroup from "../editor-devtools/UndoGroup.js";
import {getVariableUsesById, getOrderedTopBlockColumns} from "../editor-devtools/utils.js"

export default function doCleanUp(block, getWorkspace, msg) {
  let workspace = getWorkspace();
  let makeSpaceForBlock = block && block.getRootBlock();

  UndoGroup.startUndoGroup(workspace);

  let result = getOrderedTopBlockColumns(true, workspace);
  let columns = result.cols;
  let orphanCount = result.orphans.blocks.length;
  if (orphanCount > 0 && !block) {
    let message = msg("orphaned", {
      count: orphanCount,
    });
    if (confirm(message)) {
      for (const block of result.orphans.blocks) {
        block.dispose();
      }
    } else {
      columns.unshift(result.orphans);
    }
  }

  let cursorX = 48;

  let maxWidths = result.maxWidths;

  for (const column of columns) {
    let cursorY = 64;
    let maxWidth = 0;

    for (const block of column.blocks) {
      let extraWidth = block === makeSpaceForBlock ? 380 : 0;
      let extraHeight = block === makeSpaceForBlock ? 480 : 72;
      let xy = block.getRelativeToSurfaceXY();
      if (cursorX - xy.x !== 0 || cursorY - xy.y !== 0) {
        block.moveBy(cursorX - xy.x, cursorY - xy.y);
      }
      let heightWidth = block.getHeightWidth();
      cursorY += heightWidth.height + extraHeight;

      let maxWidthWithComments = maxWidths[block.id] || 0;
      maxWidth = Math.max(maxWidth, Math.max(heightWidth.width + extraWidth, maxWidthWithComments));
    }

    cursorX += maxWidth + 96;
  }

  let topComments = workspace.getTopComments();
  for (const comment of topComments) {
    if (comment.setVisible) {
      comment.setVisible(false);
      comment.needsAutoPositioning_ = true;
      comment.setVisible(true);
    }
  }

  setTimeout(() => {
    // Locate unused local variables...
    let workspace = getWorkspace();
    let map = workspace.getVariableMap();
    let vars = map.getVariablesOfType("");
    let unusedLocals = [];

    for (const row of vars) {
      if (row.isLocal) {
        let usages = getVariableUsesById(row.getId(), workspace);
        if (!usages || usages.length === 0) {
          unusedLocals.push(row);
        }
      }
    }

    if (unusedLocals.length > 0) {
      const unusedCount = unusedLocals.length;
      let message = msg("unused-var", {
        count: unusedCount,
      });
      for (let i = 0; i < unusedLocals.length; i++) {
        let orphan = unusedLocals[i];
        if (i > 0) {
          message += ", ";
        }
        message += orphan.name;
      }
      if (confirm(message)) {
        for (const orphan of unusedLocals) {
          workspace.deleteVariableById(orphan.getId());
        }
      }
    }

    // Locate unused local lists...
    let lists = map.getVariablesOfType("list");
    let unusedLists = [];

    for (const row of lists) {
      if (row.isLocal) {
        let usages = getVariableUsesById(row.getId(), workspace);
        if (!usages || usages.length === 0) {
          unusedLists.push(row);
        }
      }
    }
    if (unusedLists.length > 0) {
      const unusedCount = unusedLists.length;
      let message = msg("unused-list", {
        count: unusedCount,
      });
      for (let i = 0; i < unusedLists.length; i++) {
        let orphan = unusedLists[i];
        if (i > 0) {
          message += ", ";
        }
        message += orphan.name;
      }
      if (confirm(message)) {
        for (const orphan of unusedLists) {
          workspace.deleteVariableById(orphan.getId());
        }
      }
    }

    UndoGroup.endUndoGroup(workspace);
  }, 100);
}
