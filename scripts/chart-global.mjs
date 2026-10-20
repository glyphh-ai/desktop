// THE PAGE'S CHART LIBRARY (dist/renderer/app-libs/chart.js, loaded by a plain
// <script> in home.html; the Schedules and dashboard charts read window.Chart).
// Bundled as an IIFE that sets the global itself: chart.js's own UMD build
// registers with Monaco's AMD loader (monaco/loader.js loads first on the
// page) and never sets window.Chart (his report, 2026-10-09: the chart drew
// empty).
import { Chart, registerables } from "chart.js";

Chart.register(...registerables);
globalThis.Chart = Chart;
