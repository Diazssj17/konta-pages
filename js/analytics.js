/*
 * analytics.js - Calculos de analisis de datos y analisis financiero.
 * Funciones puras: reciben los datos (productos y ventas) y devuelven
 * los resultados listos para mostrarse en la interfaz.
 */

// Formatea un número en pesos colombianos (COP).
function formatearCOP(valor) {
  const n = Math.round(Number(valor) || 0);
  return "$ " + n.toLocaleString("es-CO");
}

// Formatea una fecha yyyy-mm-dd a un texto corto como "12 ago".
function formatearFecha(fechaStr) {
  const partes = fechaStr.split("-");
  const f = new Date(partes[0], partes[1] - 1, partes[2]);
  return f.toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}

// Fecha de hoy en formato yyyy-mm-dd.
function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

// Devuelve la fecha de hace "dias" dias en formato yyyy-mm-dd.
function haceDiasISO(dias) {
  const f = new Date();
  f.setDate(f.getDate() - dias);
  return f.toISOString().slice(0, 10);
}

// Agrupa un conjunto de ventas que ya tengan nombre_producto y total.
function agruparVentas(ventas) {
  const mapa = {};
  for (const v of ventas) {
    const clave = v.nombre_producto || "Producto";
    if (!mapa[clave]) {
      mapa[clave] = { nombre: clave, unidades: 0, ingresos: 0 };
    }
    mapa[clave].unidades += v.cantidad;
    mapa[clave].ingresos += v.total;
  }
  return Object.values(mapa);
}

// Filtra las ventas desde una fecha (inclusive).
function ventasDesde(ventas, desdeISO) {
  return ventas.filter((v) => v.fecha >= desdeISO);
}

// ---------------------------------------------------------------------------
// KPIs del dashboard
// ---------------------------------------------------------------------------
function calcularKPIs(productos, ventas) {
  let ingresos = 0;
  let unidades = 0;
  let costoVendido = 0;
  const costoPorProducto = {};
  for (const p of productos) costoPorProducto[p.id] = p.costo || 0;

  for (const v of ventas) {
    ingresos += v.total;
    unidades += v.cantidad;
    costoVendido += (costoPorProducto[v.producto_id] || 0) * v.cantidad;
  }

  const utilidad = ingresos - costoVendido;
  const ventasMes = ventasDesde(ventas, hoyISO().slice(0, 8) + "01");
  let ingresosMes = 0;
  for (const v of ventasMes) ingresosMes += v.total;

  return { ingresos, unidades, utilidad, ingresosMes, numVentas: ventas.length };
}

// ---------------------------------------------------------------------------
// Producto más vendido (por unidades y por ingresos)
// ---------------------------------------------------------------------------
function productoMasVendido(ventas) {
  const agrupado = agruparVentas(ventas);
  if (agrupado.length === 0) return null;

  agrupado.sort((a, b) => b.unidades - a.unidades);
  const porUnidades = agrupado[0];

  agrupado.sort((a, b) => b.ingresos - a.ingresos);
  const porIngresos = agrupado[0];

  return { porUnidades, porIngresos, ranking: agrupado };
}

// ---------------------------------------------------------------------------
// Ventas por período (días)
// ---------------------------------------------------------------------------
function ventasPorDia(ventas, dias) {
  const desde = haceDiasISO(dias - 1);
  const resultado = [];
  const mapa = {};
  for (let i = dias - 1; i >= 0; i--) {
    const fecha = haceDiasISO(i);
    const etiqueta = formatearFecha(fecha);
    resultado.push({ fecha, etiqueta, ingresos: 0, unidades: 0 });
    mapa[fecha] = resultado[resultado.length - 1];
  }
  for (const v of ventasDesde(ventas, desde)) {
    const punto = mapa[v.fecha];
    if (punto) {
      punto.ingresos += v.total;
      punto.unidades += v.cantidad;
    }
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Ventas por mes (últimos N meses)
// ---------------------------------------------------------------------------
function ventasPorMes(ventas, meses) {
  const resultado = [];
  const ahora = new Date();
  const mapa = {};
  for (let i = meses - 1; i >= 0; i--) {
    const f = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    const clave = f.getFullYear() + "-" + String(f.getMonth() + 1).padStart(2, "0");
    const etiqueta = f.toLocaleDateString("es-CO", { month: "short", year: "2-digit" });
    resultado.push({ clave, etiqueta, ingresos: 0, unidades: 0 });
    mapa[clave] = resultado[resultado.length - 1];
  }
  for (const v of ventas) {
    const clave = v.fecha.slice(0, 7);
    if (mapa[clave]) {
      mapa[clave].ingresos += v.total;
      mapa[clave].unidades += v.cantidad;
    }
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Ingresos por categoría
// ---------------------------------------------------------------------------
function ingresosPorCategoria(productos, ventas) {
  const categoriaDe = {};
  for (const p of productos) categoriaDe[p.id] = p.categoria || "Sin categoría";
  const mapa = {};
  for (const v of ventas) {
    const cat = categoriaDe[v.producto_id] || "Sin categoría";
    if (!mapa[cat]) mapa[cat] = 0;
    mapa[cat] += v.total;
  }
  const resultado = Object.entries(mapa).map(([categoria, ingresos]) => ({ categoria, ingresos }));
  resultado.sort((a, b) => b.ingresos - a.ingresos);
  return resultado;
}

// ---------------------------------------------------------------------------
// Stock bajo / agotado
// ---------------------------------------------------------------------------
function productosConStockBajo(productos) {
  const bajos = [];
  const agotados = [];
  for (const p of productos) {
    const minimo = p.stock_minimo || 0;
    if (p.stock <= 0) agotados.push(p);
    else if (p.stock <= minimo) bajos.push(p);
  }
  bajos.sort((a, b) => a.stock - b.stock);
  agotados.sort((a, b) => a.stock - b.stock);
  return { bajos, agotados };
}

export {
  formatearCOP,
  formatearFecha,
  hoyISO,
  haceDiasISO,
  agruparVentas,
  ventasDesde,
  calcularKPIs,
  productoMasVendido,
  ventasPorDia,
  ventasPorMes,
  ingresosPorCategoria,
  productosConStockBajo,
};