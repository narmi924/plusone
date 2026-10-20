import type { AgWidgetField } from "ag-studio";
import { type AgGridWidgetOptions, createWidgets } from "ag-studio-react";
import { CaptureCell, MoneyCell, StatusCell } from "./cells";

const gridOptions: AgGridWidgetOptions = {
  // Pick a renderer from the `context.cell` set on each field in data.ts.
  createCellRenderer: (field: AgWidgetField) => {
    switch ((field.context as { cell?: string } | undefined)?.cell) {
      case "status":
        return StatusCell;
      case "money":
        return MoneyCell;
      case "capture":
        return CaptureCell;
      default:
        return undefined;
    }
  },
};

// Module level: Studio compares props by reference on every render.
export const reportWidgets = createWidgets({ overrides: [{ id: "grid", options: gridOptions }] });
