/**
 * inSCADA MCP - Chart Generator Module
 * 
 * InfluxDB verisinden sunucu tarafında chart image (PNG) üretir.
 * chartjs-node-canvas kullanır (headless, browser gerekmez).
 */

const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

// Chart.js time scale için date adapter
require("chartjs-adapter-date-fns");

// Chart renderer (800x400 varsayılan)
const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 450;

/**
 * Renk paleti - birden fazla seri için
 */
const COLORS = [
  { border: "rgba(54, 162, 235, 1)", bg: "rgba(54, 162, 235, 0.15)" },   // mavi
  { border: "rgba(255, 99, 132, 1)", bg: "rgba(255, 99, 132, 0.15)" },   // kırmızı
  { border: "rgba(75, 192, 192, 1)", bg: "rgba(75, 192, 192, 0.15)" },   // yeşil
  { border: "rgba(255, 159, 64, 1)", bg: "rgba(255, 159, 64, 0.15)" },   // turuncu
  { border: "rgba(153, 102, 255, 1)", bg: "rgba(153, 102, 255, 0.15)" }, // mor
  { border: "rgba(255, 205, 86, 1)", bg: "rgba(255, 205, 86, 0.15)" },   // sarı
];

/**
 * InfluxDB formatındaki sonuçları chart data'sına çevirir
 */
function influxResultToChartData(influxResults, field = "value") {
  const datasets = [];

  if (!Array.isArray(influxResults)) {
    influxResults = [influxResults];
  }

  for (let i = 0; i < influxResults.length; i++) {
    const series = influxResults[i];
    if (!series || !series.data || series.data.length === 0) continue;

    const color = COLORS[i % COLORS.length];

    // Tag'lardan label oluştur
    let label = series.measurement || "data";
    if (series.tags && Object.keys(series.tags).length > 0) {
      label = Object.values(series.tags).join(" / ");
    }

    const points = series.data
      .filter((row) => row.time && row[field] !== null && row[field] !== undefined)
      .map((row) => ({
        x: new Date(row.time),
        y: typeof row[field] === "number" ? row[field] : parseFloat(row[field]),
      }))
      .filter((p) => !isNaN(p.y));

    if (points.length > 0) {
      datasets.push({
        label,
        data: points,
        borderColor: color.border,
        backgroundColor: color.bg,
        borderWidth: 2,
        pointRadius: points.length > 100 ? 0 : 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.3,
      });
    }
  }

  return datasets;
}

/**
 * Line chart PNG üretir
 */
async function generateLineChart({
  datasets,
  title = "",
  xLabel = "Zaman",
  yLabel = "Değer",
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}) {
  const chartCanvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "#ffffff",
  });

  const config = {
    type: "line",
    data: { datasets },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: {
          display: !!title,
          text: title,
          font: { size: 16, weight: "bold" },
          padding: { bottom: 15 },
        },
        legend: {
          display: datasets.length > 1,
          position: "top",
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            displayFormats: {
              minute: "HH:mm",
              hour: "HH:mm",
              day: "MMM dd",
            },
          },
          title: { display: true, text: xLabel },
        },
        y: {
          title: { display: true, text: yLabel },
          beginAtZero: false,
        },
      },
    },
  };

  return await chartCanvas.renderToBuffer(config);
}

/**
 * Bar chart PNG üretir (istatistik karşılaştırma için)
 */
async function generateBarChart({
  labels,
  values,
  title = "",
  yLabel = "Değer",
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}) {
  const chartCanvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "#ffffff",
  });

  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: COLORS.map((c) => c.bg).slice(0, labels.length),
          borderColor: COLORS.map((c) => c.border).slice(0, labels.length),
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: {
          display: !!title,
          text: title,
          font: { size: 16, weight: "bold" },
        },
        legend: { display: false },
      },
      scales: {
        y: {
          title: { display: true, text: yLabel },
          beginAtZero: false,
        },
      },
    },
  };

  return await chartCanvas.renderToBuffer(config);
}

/**
 * Gauge chart (anlık değer göstergesi) PNG üretir
 */
async function generateGaugeChart({
  value,
  min = 0,
  max = 100,
  title = "",
  unit = "",
  width = 400,
  height = 300,
}) {
  const chartCanvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "#ffffff",
  });

  // Gauge'u doughnut ile simüle ediyoruz
  const percentage = Math.min(Math.max((value - min) / (max - min), 0), 1);
  const remaining = 1 - percentage;

  // Renk: yeşil → sarı → kırmızı
  let color;
  if (percentage < 0.5) color = "rgba(75, 192, 192, 0.8)";
  else if (percentage < 0.75) color = "rgba(255, 205, 86, 0.8)";
  else color = "rgba(255, 99, 132, 0.8)";

  const config = {
    type: "doughnut",
    data: {
      datasets: [
        {
          data: [percentage * 100, remaining * 100],
          backgroundColor: [color, "rgba(220, 220, 220, 0.3)"],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      circumference: 180,
      rotation: 270,
      cutout: "75%",
      plugins: {
        title: {
          display: !!title,
          text: title,
          font: { size: 14, weight: "bold" },
        },
        legend: { display: false },
        // Ortaya değer yazma (plugin ile)
      },
    },
    plugins: [
      {
        id: "gaugeText",
        afterDraw(chart) {
          const { ctx, width, height } = chart;
          ctx.save();
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = "bold 28px Arial";
          ctx.fillStyle = "#333";
          ctx.fillText(`${value.toFixed(1)}${unit}`, width / 2, height * 0.65);
          ctx.font = "12px Arial";
          ctx.fillStyle = "#888";
          ctx.fillText(`${min} - ${max}${unit}`, width / 2, height * 0.78);
          ctx.restore();
        },
      },
    ],
  };

  return await chartCanvas.renderToBuffer(config);
}

module.exports = {
  influxResultToChartData,
  generateLineChart,
  generateBarChart,
  generateGaugeChart,
};
