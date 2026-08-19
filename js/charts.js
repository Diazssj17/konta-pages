/*
 * charts.js - Graficas SVG sencillas dibujadas con JavaScript puro.
 * No necesita librerías externas ni conexión a internet.
 */

// Dibuja un grafico de barras a partir de una serie {etiqueta, valor, texto}.
// Devuelve un elemento SVG.
function graficoBarras(datos, opciones) {
  opciones = opciones || {};
  const alto = opciones.alto || 170;
  const ancho = opciones.ancho || 320;
  const colorBarra = opciones.colorBarra || "#d97706";
  const colorBarra2 = opciones.colorBarra2 || "#f59e0b";
  const esDoble = datos.length > 15;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 " + ancho + " " + alto);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.width = "100%";
  svg.style.height = "auto";

  const margenIzq = 8;
  const margenAbajo = 22;
  const areaAlto = alto - margenAbajo - 12;
  const areaAncho = ancho - margenIzq - 8;

  if (!datos || datos.length === 0) {
    const texto = document.createElementNS(svgNS, "text");
    texto.setAttribute("x", ancho / 2);
    texto.setAttribute("y", alto / 2);
    texto.setAttribute("text-anchor", "middle");
    texto.setAttribute("fill", "#9ca3af");
    texto.setAttribute("font-size", "13");
    texto.textContent = "Sin datos todavía";
    svg.appendChild(texto);
    return svg;
  }

  const max = Math.max.apply(null, datos.map((d) => d.valor)) || 1;
  const n = datos.length;
  const paso = areaAncho / n;
  const barraAncho = Math.max(4, Math.min(26, paso * 0.62));

  for (let i = 0; i < n; i++) {
    const d = datos[i];
    const x = margenIzq + i * paso + (paso - barraAncho) / 2;
    const altura = (d.valor / max) * areaAlto;
    const y = margenAbajo + areaAlto - altura;

    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", barraAncho);
    rect.setAttribute("height", Math.max(altura, d.valor > 0 ? 2 : 0));
    rect.setAttribute("rx", "3");
    rect.setAttribute("fill", i % 2 === 0 ? colorBarra : colorBarra2);

    const titulo = document.createElementNS(svgNS, "title");
    titulo.textContent = d.etiqueta + ": " + (d.texto || d.valor);
    rect.appendChild(titulo);
    svg.appendChild(rect);

    // Etiqueta debajo de cada barra (solo si no hay demasiadas barras).
    if (!esDoble || i % 2 === 0) {
      const etiqueta = document.createElementNS(svgNS, "text");
      etiqueta.setAttribute("x", x + barraAncho / 2);
      etiqueta.setAttribute("y", alto - 6);
      etiqueta.setAttribute("text-anchor", "middle");
      etiqueta.setAttribute("fill", "#9ca3af");
      etiqueta.setAttribute("font-size", "9");
      etiqueta.textContent = d.etiqueta;
      svg.appendChild(etiqueta);
    }
  }

  return svg;
}

// Dibuja un grafico de torta (pastel) para datos de categorías.
// datos: [{etiqueta, valor, texto}]
function graficoTorta(datos, opciones) {
  opciones = opciones || {};
  const alto = opciones.alto || 190;
  const ancho = opciones.ancho || 320;
  const colores = opciones.colores || ["#d97706", "#f59e0b", "#fcd34d", "#a16207", "#fbbf24", "#92400e"];

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 " + ancho + " " + alto);
  svg.style.width = "100%";
  svg.style.height = "auto";

  const total = datos.reduce((s, d) => s + d.valor, 0);
  if (total <= 0) {
    const texto = document.createElementNS(svgNS, "text");
    texto.setAttribute("x", ancho / 2);
    texto.setAttribute("y", alto / 2);
    texto.setAttribute("text-anchor", "middle");
    texto.setAttribute("fill", "#9ca3af");
    texto.setAttribute("font-size", "13");
    texto.textContent = "Sin datos todavía";
    svg.appendChild(texto);
    return svg;
  }

  const cx = ancho * 0.42;
  const cy = alto / 2;
  const r = Math.min(alto / 2, ancho * 0.30) - 8;

  let acumulado = 0;
  const offset = -Math.PI / 2;

  for (let i = 0; i < datos.length; i++) {
    const angulo = (datos[i].valor / total) * Math.PI * 2;
    const inicio = acumulado + offset;
    const fin = acumulado + angulo + offset;
    acumulado += angulo;

    if (angulo <= 0) continue;

    const x1 = cx + r * Math.cos(inicio);
    const y1 = cy + r * Math.sin(inicio);
    const x2 = cx + r * Math.cos(fin);
    const y2 = cy + r * Math.sin(fin);
    const grande = angulo > Math.PI ? 1 : 0;

    const d =
      "M " + cx + " " + cy +
      " L " + x1 + " " + y1 +
      " A " + r + " " + r + " 0 " + grande + " 1 " + x2 + " " + y2 + " Z";

    const segmento = document.createElementNS(svgNS, "path");
    segmento.setAttribute("d", d);
    segmento.setAttribute("fill", colores[i % colores.length]);

    const titulo = document.createElementNS(svgNS, "title");
    titulo.textContent = datos[i].etiqueta + ": " + (datos[i].texto || datos[i].valor);
    segmento.appendChild(titulo);
    svg.appendChild(segmento);
  }

  return svg;
}

// Construye una lista de leyenda (puntos de color + etiqueta + valor).
function leyenda(datos, contenedor, colores) {
  colores = colores || ["#d97706", "#f59e0b", "#fcd34d", "#a16207", "#fbbf24", "#92400e"];
  contenedor.innerHTML = "";
  datos.forEach((d, i) => {
    const fila = document.createElement("div");
    fila.className = "leyenda-fila";

    const punto = document.createElement("span");
    punto.className = "leyenda-punto";
    punto.style.background = colores[i % colores.length];

    const texto = document.createElement("span");
    texto.className = "leyenda-texto";
    texto.textContent = d.etiqueta;

    const valor = document.createElement("span");
    valor.className = "leyenda-valor";
    valor.textContent = d.texto || d.valor;

    fila.appendChild(punto);
    fila.appendChild(texto);
    fila.appendChild(valor);
    contenedor.appendChild(fila);
  });
}

export { graficoBarras, graficoTorta, leyenda };