import { studioTheme } from "ag-studio";

// The report sits on the same table as the labels: kraft canvas, white
// widgets with a 2px black edge and die-cut corners, black ink, yellow for
// what's held, red for live, green for money in.
const C = {
  kraft: "#e6d3b6",
  white: "#ffffff",
  black: "#000000",
  quiet: "#6a6258",
  line: "#e7e1d7",
  sticker: "#ffe500",
  pen: "#e4002b",
  paid: "#13883e",
} as const;

const FONT = '"Archivo", ui-sans-serif, system-ui, sans-serif';

export const reportTheme = studioTheme.withParams({
  fontFamily: FONT,
  fontSize: 14,
  accentColor: C.black,
  backgroundColor: C.white,
  foregroundColor: C.black,
  textColor: C.black,
  subtleTextColor: C.quiet,
  borderColor: C.line,
  borderRadius: 8,
  spacing: 6,
  studioWrapperBorder: false,
  studioCanvasBackgroundColor: C.kraft,
  studioCanvasPadding: 20,
  studioWidgetBackgroundColor: C.white,
  studioWidgetBorder: { width: 2, color: C.black },
  studioWidgetBorderRadius: 10,
  studioWidgetPadding: 12,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 800,
  studioValueWidgetFontSize: 40,
  gridHeaderBackgroundColor: C.white,
  gridHeaderTextColor: C.quiet,
  gridRowHeight: 40,
  gridRowBorder: { width: 1, color: C.line },
  gridWrapperBorder: false,
  chartFontFamily: FONT,
  chartGridLineColor: C.line,
  chartPaletteFills1Color: C.sticker,
  chartPaletteStrokes1Color: C.black,
  chartPaletteFills2Color: C.black,
  chartPaletteStrokes2Color: C.black,
  chartPaletteFills3Color: C.pen,
  chartPaletteStrokes3Color: C.pen,
  chartPaletteFills4Color: C.paid,
  chartPaletteStrokes4Color: C.paid,
  chartPaletteFills5Color: C.quiet,
  chartPaletteStrokes5Color: C.quiet,
});
