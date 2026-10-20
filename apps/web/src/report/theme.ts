import { studioTheme } from "ag-studio";

// The report uses the order book's materials: paper, blue ballpoint, the
// highlighter yellow, the margin red, the green tick. Thin rules instead of
// shadowed cards, and the grid's row lines are the book's blue rules.
const C = {
  paper: "#fbfcfe",
  white: "#ffffff",
  black: "#000000",
  ink: "#2140a8",
  quiet: "#6b6b66",
  line: "#dcdcd6",
  rule: "#d3e0f4",
  sticker: "#ffe500",
  pen: "#e4002b",
  paid: "#13883e",
} as const;

const FONT = '"Archivo", ui-sans-serif, system-ui, sans-serif';

export const reportTheme = studioTheme.withParams({
  fontFamily: FONT,
  fontSize: 14,
  accentColor: C.ink,
  backgroundColor: C.white,
  foregroundColor: C.black,
  textColor: C.black,
  subtleTextColor: C.quiet,
  borderColor: C.line,
  borderRadius: 4,
  spacing: 6,
  studioWrapperBorder: false,
  studioCanvasBackgroundColor: C.paper,
  studioCanvasPadding: 20,
  studioWidgetBackgroundColor: C.white,
  studioWidgetBorder: { width: 1, color: C.line },
  studioWidgetBorderRadius: 4,
  studioWidgetPadding: 12,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 800,
  studioValueWidgetFontSize: 40,
  gridHeaderBackgroundColor: C.white,
  gridHeaderTextColor: C.quiet,
  gridRowHeight: 40,
  gridRowBorder: { width: 1, color: C.rule },
  gridWrapperBorder: false,
  chartFontFamily: FONT,
  chartGridLineColor: C.rule,
  chartPaletteFills1Color: C.ink,
  chartPaletteStrokes1Color: C.ink,
  chartPaletteFills2Color: C.sticker,
  chartPaletteStrokes2Color: "#c9b400",
  chartPaletteFills3Color: C.pen,
  chartPaletteStrokes3Color: C.pen,
  chartPaletteFills4Color: C.paid,
  chartPaletteStrokes4Color: C.paid,
  chartPaletteFills5Color: C.quiet,
  chartPaletteStrokes5Color: C.quiet,
});
