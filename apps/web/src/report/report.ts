import type { AgReportState, AgWidgetLayoutState } from "ag-studio";

// The report the seller sees first. The canvas is 24 columns wide; one row is
// 16px. The seller (or the assistant) can rearrange it.

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({
  xTrack,
  yTrack,
  xSpan,
  ySpan,
});

const statusIs = (...value: string[]) => [
  { field: { id: "lines.status" }, model: { operator: "isIn" as const, value } },
];

export const initialReport: AgReportState = {
  selectedPageId: "tonight",
  panels: { filters: { collapsed: true }, ai: { collapsed: false } },
  pages: [
    {
      id: "tonight",
      widgets: {
        taken: {
          type: "value",
          dataMapping: { value: [{ id: "lines.amount", aggregation: "sum" }] },
          format: { title: { enabled: true, text: "Taken with PayPal" } },
        },
        owed: {
          type: "value",
          dataMapping: { value: [{ id: "lines.amount", aggregation: "sum" }] },
          format: { title: { enabled: true, text: "Held, waiting to pay" } },
        },
        sold: {
          type: "value",
          dataMapping: { value: [{ id: "lines.qty", aggregation: "sum" }] },
          format: { title: { enabled: true, text: "Items sold" } },
        },
        byProduct: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "lines.product" }],
            valueKey: [{ id: "lines.qty", aggregation: "sum" }],
          },
          format: { title: { enabled: true, text: "Units held or sold, by product" } },
        },
        stock: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "stock.product" },
              { id: "stock.variant" },
              { id: "stock.available", aggregation: "sum" },
              { id: "stock.held", aggregation: "sum" },
              { id: "stock.sold", aggregation: "sum" },
              { id: "stock.waiting", aggregation: "sum" },
            ],
          },
          format: { title: { enabled: true, text: "Stock" } },
        },
        lines: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "lines.order" },
              { id: "lines.buyer" },
              { id: "lines.product" },
              { id: "lines.variant" },
              { id: "lines.status" },
              { id: "lines.qty", aggregation: "sum" },
              { id: "lines.amount", aggregation: "sum" },
              { id: "lines.captureId" },
              { id: "lines.placed" },
            ],
          },
          sort: [{ field: { id: "lines.placed" }, direction: "desc" }],
          format: { title: { enabled: true, text: "Every order line" } },
        },
      },
      widgetLayout: {
        taken: at(0, 0, 8, 7),
        owed: at(8, 0, 8, 7),
        sold: at(16, 0, 8, 7),
        byProduct: at(0, 7, 10, 18),
        stock: at(10, 7, 14, 18),
        lines: at(0, 25, 24, 26),
      },
      filter: {
        widget: {
          taken: statusIs("paid"),
          owed: statusIs("held"),
          sold: statusIs("paid"),
          byProduct: statusIs("held", "paid"),
        },
      },
    },
  ],
};
