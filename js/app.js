/*
 * app.js - Lógica principal de Konta.
 * Controla la navegación, el renderizado de cada pantalla, las ventas,
 * el inventario, las alertas de stock y las notificaciones.
 */

import {
  leer, leerTodos, guardar, eliminar, limpiar, sembrarDatosSiVacio,
  crearEmpresa, listarEmpresas, eliminarEmpresa, migrarDesdeAntigua,
  setAlCambiarDatos, aplicarRegistro,
} from "./db.js";
import {
  sembrarAdminInicial, crearUsuario, cambiarContrasena, eliminarUsuario,
  listarUsuarios, iniciarSesion, obtenerSesion, correoSesion,
  cerrarSesion, recuperarContrasena,
} from "./auth.js";
import {
  vincularCuenta, reclamarFilaUsuario, sincronizarTodo, actualizarClaveNube,
  bootstrapDesdeNube, haySesionNube, obtenerCliente,
} from "./sync.js";
import {
  formatearCOP, formatearFecha, hoyISO, haceDiasISO,
  calcularKPIs, productoMasVendido, ventasPorDia, ventasPorMes,
  ingresosPorCategoria, productosConStockBajo,
} from "./analytics.js";
import { graficoBarras, graficoTorta, leyenda } from "./charts.js";

// ---------------------------------------------------------------------------
// Estado de la aplicación
// ---------------------------------------------------------------------------
let productos = [];
let ventas = [];
let categorias = [];
let recetas = [];
let filtroVentas = 7;       // días de historial a mostrar en "Ventas"
let periodoAnalisis = 7;    // "7" | "30" | "meses"
let terminoBusqueda = "";
let productoRecetaActual = null; // producto cuya receta se está viendo/ editando
let produccionSeleccionada = null; // cálculo actual de necesidades

// ---------------------------------------------------------------------------
// Utilidades DOM
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(mensaje, tipo) {
  const t = $("#toast");
  t.textContent = mensaje;
  t.classList.remove("oculto");
  if (tipo === "error") t.style.background = "#7f1d1d";
  else t.style.background = "#1c1917";
  clearTimeout(toast._temporizador);
  toast._temporizador = setTimeout(() => t.classList.add("oculto"), 2600);
}

// ---------------------------------------------------------------------------
// Autenticación (login / cambio de clave / recuperar contraseña / admin)
// ---------------------------------------------------------------------------
let usuarioActual = null;
let empresaActual = null;  // empresa seleccionada (objeto), solo para usuarios
const CLAVE_EMPRESA = "konta_empresa";
const CLAVE_REVISION = "konta_revision";  // id de la empresa que el admin revisa
const CLAVE_ACEPTA_DATOS = "konta_acepta_datos";  // email que autorizó el uso de datos
let modoRevision = false;  // el admin está revisando los datos de una empresa

// ---------------------------------------------------------------------------
// Sincronización con la nube (Supabase)
// ---------------------------------------------------------------------------
let temporizadorSync = null;
const SYNC_ESPERA = 2500;   // espera para agrupar cambios antes de sincronizar

function actualizarIndicadorSync(estado) {
  const el = $("#sync-estado");
  if (!el) return;
  if (estado === "syncing") {
    el.textContent = "🔄";
    el.className = "sync-estado activo";
    el.title = "Sincronizando…";
  } else if (estado === "online") {
    el.textContent = "☁️";
    el.className = "sync-estado";
    el.title = "Datos sincronizados con la nube";
  } else {
    el.textContent = "📴";
    el.className = "sync-estado";
    el.title = "Sin conexión: los cambios se guardan localmente";
  }
}

// Programa una sincronización (agrupa varios cambios seguidos).
function programarSync() {
  clearTimeout(temporizadorSync);
  temporizadorSync = setTimeout(() => ejecutarSync(), SYNC_ESPERA);
}

// Ejecuta la sincronización y refresca la vista si la nube trajo cambios.
async function ejecutarSync() {
  const correo = correoSesion();
  if (!correo) return;
  if (!navigator.onLine) {
    actualizarIndicadorSync("offline");
    return;
  }
  actualizarIndicadorSync("syncing");
  let res = null;
  try {
    res = await sincronizarTodo(correo);
  } catch (err) {
    res = { ok: false };
  }
  if (res && res.ok) {
    actualizarIndicadorSync("online");
    if (res.aplicados) await recargarDespuesSync();
  } else {
    actualizarIndicadorSync("offline");
  }
}

async function recargarDespuesSync() {
  try {
    if (esAdmin() && !modoRevision) {
      await renderAdmin();
      cambiarVista("admin");
    } else {
      await cargarDatos();
      const vista = $(".vista.activa") ? $(".vista.activa").id.replace("vista-", "") : "dashboard";
      renderVista(vista);
      actualizarAlertas();
      notificarStockBajo();
    }
  } catch (err) {
    console.error("Recarga tras sincronización:", err);
  }
}

// Tras un login local correcto, vincula la cuenta con la nube (si hay red) y
// programa la sincronización. Guardamos la promesa para que el cambio de
// contraseña del primer ingreso espere a que el alta termine.
let promesaVinculo = null;

async function trasLogin(correo, contrasena) {
  promesaVinculo = vincularCuenta(correo, contrasena).then(async (v) => {
    if (v.ok) {
      await reclamarFilaUsuario();
    } else if (v.error && navigator.onLine) {
      toast("Nube: " + v.error, "error");
    }
    programarSync();
  });
  await promesaVinculo;
}

function mostrarPantallaAuth(mostrar) {
  $("#pantalla-auth").classList.toggle("oculto", !mostrar);
  $(".app").classList.toggle("oculto", mostrar);
  if (mostrar) {
    $(".navegacion").style.display = "none";
  } else {
    $(".navegacion").style.display = "";
  }
}

function cambiarFormAuth(activo) {
  ["login", "cambiar", "recuperar", "nueva"].forEach((n) => {
    const f = $("#form-" + n);
    if (f) f.classList.toggle("oculto", n !== activo);
  });
  ["login-error", "cambiar-error", "rec-error", "nueva-error"].forEach((id) => {
    const el = $("#" + id);
    if (el) el.textContent = "";
  });
}

function esAdmin() {
  return usuarioActual && usuarioActual.rol === "admin";
}

function esUsuarioNormal() {
  return usuarioActual && usuarioActual.rol !== "admin";
}

// Rellena el selector de empresa del login con la lista global.
async function llenarLoginEmpresas() {
  const select = $("#login-empresa");
  const empresas = await listarEmpresas();
  select.innerHTML = '<option value="">Selecciona tu empresa…</option>';
  empresas.forEach((emp) => {
    const op = document.createElement("option");
    op.value = emp.id;
    op.textContent = emp.nombre;
    select.appendChild(op);
  });
  // Nota para el administrador.
  $("#login-ayuda-admin").textContent = "";
}

async function manejarLogin(e) {
  e.preventDefault();
  const correo = $("#login-correo").value;
  const contrasena = $("#login-contrasena").value;
  const empresaElegida = $("#login-empresa").value;

  let resultado = await iniciarSesion(correo, contrasena, empresaElegida);

  // Si la cuenta no existe localmente (dispositivo nuevo), la activamos desde
  // la nube con la misma contraseña y bajamos todos sus datos.
  if (!resultado.ok && navigator.onLine &&
      resultado.error && resultado.error.indexOf("No existe una cuenta") !== -1) {
    $("#login-error").textContent = "Activando cuenta desde la nube…";
    const act = await bootstrapDesdeNube(correo, contrasena);
    if (act.ok) {
      // En un dispositivo nuevo aún no existe la cuenta local: la creamos con
      // los datos (incluida la contraseña) que vienen de la nube, para que la
      // sincronización del resto de tablas pueda empezar desde aquí.
      const sb = obtenerCliente();
      const { data } = await sb.from("usuarios").select("*").eq("email", correo);
      const fila = (data || [])[0];
      if (fila && fila.datos && typeof fila.datos === "object" && fila.datos.password_hash) {
        await aplicarRegistro("usuarios", { ...fila.datos }, null);
      } else {
        $("#login-error").textContent = "La cuenta aún no tiene datos en la nube. Inicia sesión primero en el dispositivo donde se creó.";
        return;
      }
      await sincronizarTodo(correo);
      const usuarioNube = await leer(correo, "usuarios");
      const empresaBootstrap = usuarioNube && usuarioNube.empresa_id != null
        ? String(usuarioNube.empresa_id)
        : empresaElegida;
      resultado = await iniciarSesion(correo, contrasena, empresaBootstrap);
      if (resultado.ok) await llenarLoginEmpresas();
    } else {
      $("#login-error").textContent = act.error;
      return;
    }
  }

  if (!resultado.ok) {
    $("#login-error").textContent = resultado.error;
    return;
  }
  usuarioActual = resultado.usuario;
  $("#form-login").reset();
  $("#login-error").textContent = "";

  trasLogin(correo, contrasena);

  if (resultado.requiereCambio) {
    // Primera vez: debe cambiar la contraseña antes de entrar.
    $("#cambiar-nota").textContent = "Hola " + (usuarioActual.nombre || "") + ". Por seguridad debes cambiar tu contraseña antes de continuar.";
    $("#cambiar-contrasena").value = "";
    $("#cambiar-confirma").value = "";
    cambiarFormAuth("cambiar");
    return;
  }

  if (esAdmin()) {
    // El administrador entra directo al panel de administración.
    await entrarAdmin();
    return;
  }

  await entrarApp();
}

async function manejarCambiar(e) {
  e.preventDefault();
  const nueva = $("#cambiar-contrasena").value;
  const confirma = $("#cambiar-confirma").value;
  if (nueva !== confirma) {
    $("#cambiar-error").textContent = "Las contraseñas no coinciden.";
    return;
  }
  const resultado = await cambiarContrasena(usuarioActual.email, nueva);
  if (!resultado.ok) {
    $("#cambiar-error").textContent = resultado.error;
    return;
  }
  toast("Contraseña actualizada.");
  if (promesaVinculo) {
    await promesaVinculo.catch(() => {});
    promesaVinculo = null;
  }
  await actualizarClaveNube(nueva);
  programarSync();
  $("#cambiar-contrasena").value = "";
  $("#cambiar-confirma").value = "";
  if (esAdmin()) {
    await entrarAdmin();
  } else {
    await entrarApp();
  }
}

async function manejarRecuperar(e) {
  e.preventDefault();
  const correo = $("#rec-correo").value.trim().toLowerCase();
  const usuario = await obtenerSesionPorCorreo(correo);
  if (!usuario) {
    $("#rec-error").textContent = "No existe una cuenta con ese correo.";
    return;
  }
  // Guardamos el correo para la siguiente pantalla.
  $("#form-nueva").dataset.correo = correo;
  $("#nueva-pregunta").textContent = "Pregunta de seguridad: " + usuario.pregunta;
  $("#rec-error").textContent = "";
  cambiarFormAuth("nueva");
  $("#rec-correo").value = "";
}

async function manejarNueva(e) {
  e.preventDefault();
  const correo = $("#form-nueva").dataset.correo;
  const resultado = await recuperarContrasena(
    correo,
    $("#nueva-respuesta").value,
    $("#nueva-contrasena").value
  );
  if (!resultado.ok) {
    $("#nueva-error").textContent = resultado.error;
    return;
  }
  toast("Contraseña restablecida. Inicia sesión.");
  actualizarClaveNube($("#nueva-contrasena").value);
  cambiarFormAuth("login");
  $("#login-correo").value = correo;
  $("#form-nueva").reset();
}

async function obtenerSesionPorCorreo(correo) {
  try {
    return await leer(correo, "usuarios");
  } catch {
    return null;
  }
}

// Entra a la app como usuario normal (con la empresa que eligió en el login).
async function entrarApp() {
  const empresaId = Number($("#login-empresa").value) || usuarioActual.empresa_id;
  const empresas = await listarEmpresas();
  empresaActual = empresas.find((emp) => emp.id === Number(empresaId)) || null;

  // La empresa activa queda en localStorage: todas las operaciones de datos
  // (leer/guardar) se enrutan a la base de datos propia de esa empresa.
  if (empresaActual) {
    localStorage.setItem(CLAVE_EMPRESA, String(empresaActual.id));
  } else {
    localStorage.removeItem(CLAVE_EMPRESA);
  }

  $("#nav-admin").classList.add("oculto");
  $("#btn-ayuda").classList.toggle("oculto", !esUsuarioNormal());
  $("#btn-volver-admin").classList.add("oculto");
  mostrarPantallaAuth(false);
  try {
    await sembrarDatosSiVacio(empresaActual ? empresaActual.id : null);
    await cargarDatos();
  } catch (err) {
    console.error("Error al cargar los datos:", err);
  }
  $("#config-correo-sesion").textContent = (usuarioActual && usuarioActual.email) || "";
  $("#config-empresa-nombre").textContent = (empresaActual && empresaActual.nombre) || "";
  cambiarVista("dashboard");
  actualizarAlertas();
  actualizarEstadoNotif();
  notificarStockBajo();
}

function manejarCerrarSesion() {
  cerrarSesion();
  usuarioActual = null;
  empresaActual = null;
  modoRevision = false;
  localStorage.removeItem(CLAVE_EMPRESA);
  localStorage.removeItem(CLAVE_REVISION);
  $("#nav-admin").classList.add("oculto");
  $("#btn-ayuda").classList.add("oculto");
  $("#btn-volver-admin").classList.add("oculto");
  mostrarPantallaAuth(true);
  llenarLoginEmpresas();
  cambiarFormAuth("login");
  $("#form-login").reset();
}

// ---------------------------------------------------------------------------
// Panel de administración (solo admin global)
// ---------------------------------------------------------------------------

async function entrarAdmin() {
  modoRevision = false;
  localStorage.removeItem(CLAVE_REVISION);
  localStorage.removeItem(CLAVE_EMPRESA);
  mostrarPantallaAuth(false);
  $("#nav-admin").classList.remove("oculto");
  $("#btn-ayuda").classList.add("oculto");
  $("#btn-volver-admin").classList.add("oculto");
  $("#config-correo-sesion").textContent = (usuarioActual && usuarioActual.email) || "";
  $("#config-empresa-nombre").textContent = "—";
  renderAdmin();
  cambiarVista("admin");
  programarSync();
}

// El administrador entra a revisar los datos de una empresa (lee/escribe su BD).
async function entrarRevision(empresaId) {
  const empresas = await listarEmpresas();
  empresaActual = empresas.find((emp) => emp.id === Number(empresaId)) || null;
  if (!empresaActual) {
    toast("No se encontró la empresa.", "error");
    return;
  }
  modoRevision = true;
  localStorage.setItem(CLAVE_EMPRESA, String(empresaActual.id));
  localStorage.setItem(CLAVE_REVISION, String(empresaActual.id));
  $("#nav-admin").classList.remove("oculto");
  $("#btn-ayuda").classList.add("oculto");
  $("#btn-volver-admin").classList.remove("oculto");
  mostrarPantallaAuth(false);
  try {
    await sembrarDatosSiVacio(empresaActual.id);
    await cargarDatos();
  } catch (err) {
    console.error("Error al cargar los datos de la empresa:", err);
  }
  $("#config-correo-sesion").textContent = (usuarioActual && usuarioActual.email) + " (revisión)";
  $("#config-empresa-nombre").textContent = empresaActual.nombre;
  cambiarVista("dashboard");
  actualizarAlertas();
  actualizarEstadoNotif();
  notificarStockBajo();
  programarSync();
}

// ---------------------------------------------------------------------------
// Ayuda y autorización de uso de datos (solo usuarios de empresa)
// ---------------------------------------------------------------------------

function abrirAyuda() {
  const aceptado = localStorage.getItem(CLAVE_ACEPTA_DATOS) === (usuarioActual && usuarioActual.email);
  $("#chk-autorizacion-datos").checked = aceptado;
  $("#autorizacion-estado").textContent = aceptado ? "Ya autorizaste el uso de tus datos." : "";
  $("#modal-ayuda").classList.remove("oculto");
}

function cerrarAyuda() {
  $("#modal-ayuda").classList.add("oculto");
}

function guardarAutorizacion() {
  if (!$("#chk-autorizacion-datos").checked) {
    $("#autorizacion-estado").textContent = "Marca la casilla para autorizar el uso de tus datos.";
    return;
  }
  localStorage.setItem(CLAVE_ACEPTA_DATOS, usuarioActual.email);
  $("#autorizacion-estado").textContent = "Autorización guardada. Gracias.";
  toast("Autorización de datos guardada.");
}

async function renderAdmin() {
  const empresas = await listarEmpresas();

  // Lista de empresas con sus usuarios.
  const caja = $("#admin-empresas");
  caja.innerHTML = "";
  if (empresas.length === 0) {
    caja.textContent = "Aún no hay empresas. Crea la primera con el formulario.";
  } else {
    empresas.forEach((emp) => {
      const fila = document.createElement("div");
      fila.className = "admin-fila";
      const info = document.createElement("div");
      info.className = "fila-info";
      const nombre = document.createElement("div");
      nombre.className = "fila-nombre";
      nombre.textContent = emp.nombre;
      const detalle = document.createElement("div");
      detalle.className = "fila-detalle";
      detalle.textContent = "Empresa #" + emp.id;
      info.appendChild(nombre);
      info.appendChild(detalle);
      const acciones = document.createElement("div");
      acciones.className = "acciones-fila";
      const btnRevisar = document.createElement("button");
      btnRevisar.className = "btn btn-secundario btn-pequeno";
      btnRevisar.textContent = "Revisar";
      btnRevisar.addEventListener("click", () => entrarRevision(emp.id));
      acciones.appendChild(btnRevisar);
      const btnBorrar = document.createElement("button");
      btnBorrar.className = "btn btn-peligro btn-pequeno";
      btnBorrar.textContent = "Eliminar";
      btnBorrar.addEventListener("click", async () => {
        if (!confirm("¿Eliminar la empresa \"" + emp.nombre + "\" y toda su base de datos?")) return;
        await eliminarEmpresa(emp.id);
        toast("Empresa eliminada.");
        renderAdmin();
      });
      acciones.appendChild(btnBorrar);
      fila.appendChild(info);
      fila.appendChild(acciones);
      caja.appendChild(fila);
    });
  }

  // Selector de empresa para el formulario de usuario.
  const selectEmpresa = $("#admin-usuario-empresa");
  selectEmpresa.innerHTML = '<option value="">Empresa…</option>';
  empresas.forEach((emp) => {
    const op = document.createElement("option");
    op.value = emp.id;
    op.textContent = emp.nombre;
    selectEmpresa.appendChild(op);
  });

  // Lista de usuarios.
  const usuarios = await listarUsuarios();
  const cajaUsuarios = $("#admin-lista-usuarios");
  cajaUsuarios.innerHTML = "";
  if (usuarios.length === 0) {
    cajaUsuarios.textContent = "Aún no hay usuarios.";
  } else {
    const idNombre = {};
    empresas.forEach((emp) => { idNombre[emp.id] = emp.nombre; });
    usuarios.forEach((u) => {
      const fila = document.createElement("div");
      fila.className = "admin-fila";
      const info = document.createElement("div");
      info.className = "fila-info";
      const nombre = document.createElement("div");
      nombre.className = "fila-nombre";
      nombre.textContent = u.nombre + (u.rol === "admin" ? " (admin)" : "");
      const detalle = document.createElement("div");
      detalle.className = "fila-detalle";
      detalle.textContent = u.email + " · " + (u.empresa_id ? (idNombre[u.empresa_id] || "Empresa #" + u.empresa_id) : "Global");
      info.appendChild(nombre);
      info.appendChild(detalle);
      const acciones = document.createElement("div");
      acciones.className = "acciones-fila";
      if (u.rol !== "admin") {
        const btnBorrar = document.createElement("button");
        btnBorrar.className = "btn btn-peligro btn-pequeno";
        btnBorrar.textContent = "Eliminar";
        btnBorrar.addEventListener("click", async () => {
          if (!confirm("¿Eliminar el usuario " + u.email + "?")) return;
          await eliminarUsuario(u.email);
          toast("Usuario eliminado.");
          renderAdmin();
        });
        acciones.appendChild(btnBorrar);
      }
      fila.appendChild(info);
      fila.appendChild(acciones);
      cajaUsuarios.appendChild(fila);
    });
  }
}

async function manejarCrearEmpresa(e) {
  e.preventDefault();
  const nombre = $("#admin-nueva-empresa").value.trim();
  if (!nombre) {
    $("#admin-empresa-error").textContent = "Escribe el nombre de la empresa.";
    return;
  }
  try {
    await crearEmpresa(nombre);
  } catch (err) {
    $("#admin-empresa-error").textContent = err.message;
    return;
  }
  $("#admin-nueva-empresa").value = "";
  $("#admin-empresa-error").textContent = "";
  toast("Empresa creada.");
  renderAdmin();
}

async function manejarCrearUsuario(e) {
  e.preventDefault();
  const resultado = await crearUsuario({
    correo: $("#admin-usuario-correo").value,
    nombre: $("#admin-usuario-nombre").value,
    contrasena: $("#admin-usuario-clave").value,
    empresa_id: $("#admin-usuario-empresa").value,
    pregunta: $("#admin-usuario-pregunta").value,
    respuesta: $("#admin-usuario-respuesta").value,
  });
  if (!resultado.ok) {
    $("#admin-usuario-error").textContent = resultado.error;
    return;
  }
  $("#form-crear-usuario").reset();
  $("#admin-usuario-error").textContent = "";
  toast("Usuario creado. Deberá cambiar su contraseña al entrar.");
  renderAdmin();
}

// Borra TODOS los datos locales del dispositivo (bases, caché, sesión) y
// recarga la app desde cero. La nube NO se toca.
async function restablecerDispositivo() {
  if (!confirm("¿Borrar TODOS los datos de este teléfono y volver a empezar? Esta acción no se puede deshacer.")) return;
  try {
    const sb = obtenerCliente();
    if (sb && sb.auth) await sb.auth.signOut();
  } catch (e) { /* noop */ }
  try {
    const bds = await indexedDB.databases();
    for (const { name } of bds || []) {
      if (name && (name.startsWith("konta") || name === "minegocio_db")) {
        indexedDB.deleteDatabase(name);
      }
    }
  } catch (e) { /* noop */ }
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* noop */ }
  try {
    if (self.caches) {
      const claves = await caches.keys();
      await Promise.all(claves.map((c) => caches.delete(c)));
    }
  } catch (e) { /* noop */ }
  location.reload();
}

// ---------------------------------------------------------------------------
// Navegación entre vistas
// ---------------------------------------------------------------------------
function cambiarVista(nombre) {
  $$(".vista").forEach((v) => v.classList.remove("activa"));
  $("#vista-" + nombre).classList.add("activa");
  $$(".nav-btn").forEach((b) =>
    b.classList.toggle("activo", b.dataset.vista === nombre)
  );
  renderVista(nombre);
}

function renderVista(nombre) {
  if (nombre === "dashboard") renderDashboard();
  if (nombre === "ventas") renderVentas();
  if (nombre === "productos") renderProductos();
  if (nombre === "producir") renderProducir();
  if (nombre === "analisis") renderAnalisis();
  if (nombre === "admin") renderAdmin();
}

// ---------------------------------------------------------------------------
// Carga de datos
// ---------------------------------------------------------------------------
async function cargarDatos() {
  productos = await leerTodos("productos");
  ventas = await leerTodos("ventas");
  categorias = await leerTodos("categorias");
  recetas = await leerTodos("recetas");
  // Normalizamos registros antiguos que no tienen los campos es_insumo o unidad.
  productos.forEach((p) => {
    if (p.es_insumo === undefined) p.es_insumo = false;
    if (!p.unidad) p.unidad = "unidad";
    if (p.unidad === "L") p.unidad = "ml";
    // Para insumos el campo "Costo" es el total del paquete: derivamos el
    // costo por unidad a partir del stock.
    if (p.es_insumo && p.stock > 0 && p.costo_unidad === undefined) {
      p.costo_unidad = (Number(p.costo) || 0) / p.stock;
    }
  });

  // Corrige ventas antiguas cuyo producto_id no corresponde al nombre guardado
  // (las de ejemplo se generaban con índices en vez de IDs reales).
  const idPorNombre = {};
  productos.forEach((p) => { idPorNombre[p.nombre] = p.id; });
  for (const v of ventas) {
    if (!v.nombre_producto) continue;
    const idCorrecto = idPorNombre[v.nombre_producto];
    if (idCorrecto && v.producto_id !== idCorrecto) {
      v.producto_id = idCorrecto;
      await guardar(v, "ventas");
    }
  }

  // Recalcula el costo de los productos que tienen receta (para corregir
  // costos sembrados con valores manuales distintos al de la receta).
  for (const p of productos) {
    if (p.es_insumo) continue;
    const tieneReceta = recetas.some((r) => r.producto_id === p.id);
    if (!tieneReceta) continue;
    const costoReceta = Math.round(recetas
      .filter((r) => r.producto_id === p.id)
      .reduce((acc, r) => {
        const insumo = productos.find((x) => x.id === r.insumo_id);
        return acc + (costoUnidadInsumo(insumo) * (Number(r.cantidad) || 0));
      }, 0));
    if (costoReceta > 0 && p.costo !== costoReceta) {
      p.costo = costoReceta;
      await guardar(p, "productos");
    }
  }
}

// Abreviación para mostrar la unidad.
function etiquetaUnidad(unidad) {
  if (unidad === "g") return "g";
  if (unidad === "ml") return "ml";
  return "unidad";
}

async function recargarTodo() {
  await cargarDatos();
  renderVista($(".vista.activa").id.replace("vista-", ""));
  actualizarAlertas();
}

// ---------------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------------
function renderDashboard() {
  const kpis = calcularKPIs(productos, ventas);
  const kpiProducto = productoMasVendido(ventas);

  $("#kpi-ingresos").textContent = formatearCOP(kpis.ingresosMes);
  $("#kpi-ventas").textContent = kpis.numVentas;
  $("#kpi-utilidad").textContent = formatearCOP(kpis.utilidad);
  $("#kpi-producto").textContent = kpiProducto
    ? kpiProducto.porUnidades.nombre + " (" + kpiProducto.porUnidades.unidades + " unidad)"
    : "—";

  // Últimas 5 ventas
  const ultimas = ventas.slice().sort((a, b) => (b.fecha + b.id).localeCompare(a.fecha + a.id)).slice(0, 5);
  const cajaUltimas = $("#lista-ultimas-ventas");
  cajaUltimas.innerHTML = "";
  if (ultimas.length === 0) {
    cajaUltimas.textContent = "Aún no hay ventas registradas.";
  } else {
    ultimas.forEach((v) => {
      cajaUltimas.appendChild(crearFilaVenta(v));
    });
  }

  // Stock crítico (bajo + agotado)
  const criticos = productosConStockBajo(productos);
  const cajaStock = $("#lista-stock-critico");
  cajaStock.innerHTML = "";
  const todosCriticos = criticos.agotados.concat(criticos.bajos);
  if (todosCriticos.length === 0) {
    cajaStock.innerHTML = '<span style="color:#16a34a">✅ Todo el inventario está en buen nivel.</span>';
  } else {
    todosCriticos.forEach((p) => cajaStock.appendChild(crearFilaProducto(p)));
  }

  // Top 3 más vendidos
  const cajaTop = $("#lista-top-3");
  cajaTop.innerHTML = "";
  const agrupado = productoMasVendido(ventas);
  if (!agrupado) {
    cajaTop.textContent = "Aún no hay ventas para calcular el ranking.";
  } else {
    agrupado.ranking.slice(0, 3).forEach((r, i) => {
      cajaTop.appendChild(crearFilaRanking(i + 1, r.nombre, r.unidades + " unidad · " + formatearCOP(r.ingresos)));
    });
  }
}

// ---------------------------------------------------------------------------
// VENTAS
// ---------------------------------------------------------------------------
function renderVentas() {
  // Selector de producto en el formulario (no se venden insumos).
  const select = $("#venta-producto");
  const anterior = select.value;
  select.innerHTML = "";
  productos.filter((p) => !p.es_insumo).forEach((p) => {
    const op = document.createElement("option");
    op.value = p.id;
    op.textContent = p.nombre + " — " + formatearCOP(p.precio) + " (stock: " + p.stock + ")";
    select.appendChild(op);
  });
  if (anterior) select.value = anterior;
  $("#venta-fecha").value = hoyISO();

  // Historial filtrado por días
  let lista = ventas.slice().sort((a, b) => (b.fecha + b.id).localeCompare(a.fecha + a.id));
  if (filtroVentas > 0) {
    const desde = haceDiasISO(filtroVentas - 1);
    lista = lista.filter((v) => v.fecha >= desde);
  }

  $$("#filtros-ventas .filtro-btn").forEach((b) =>
    b.classList.toggle("activo", Number(b.dataset.dias) === filtroVentas)
  );

  const caja = $("#lista-ventas");
  caja.innerHTML = "";
  if (lista.length === 0) {
    caja.textContent = "No hay ventas en este período.";
  } else {
    lista.forEach((v) => caja.appendChild(crearFilaVenta(v)));
  }
}

function crearFilaVenta(v) {
  const fila = document.createElement("div");
  fila.className = "fila-lista";

  const emoji = document.createElement("span");
  emoji.className = "fila-emoji";
  const producto = productos.find((p) => p.id === v.producto_id);
  emoji.textContent = producto ? producto.emoji : "🧾";

  const info = document.createElement("div");
  info.className = "fila-info";
  const nombre = document.createElement("div");
  nombre.className = "fila-nombre";
  nombre.textContent = v.nombre_producto || "Producto";
  const detalle = document.createElement("div");
  detalle.className = "fila-detalle";
  detalle.textContent = v.cantidad + " unidad · " + formatearFecha(v.fecha);
  info.appendChild(nombre);
  info.appendChild(detalle);

  const derecha = document.createElement("div");
  derecha.className = "fila-derecha";
  const precio = document.createElement("div");
  precio.className = "fila-precio";
  precio.textContent = formatearCOP(v.total);
  const acciones = document.createElement("div");
  acciones.className = "acciones-fila";
  const btnEliminar = document.createElement("button");
  btnEliminar.className = "btn-mini peligro";
  btnEliminar.textContent = "Eliminar";
  btnEliminar.onclick = () => eliminarVenta(v.id);
  acciones.appendChild(btnEliminar);
  derecha.appendChild(precio);
  derecha.appendChild(acciones);

  fila.appendChild(emoji);
  fila.appendChild(info);
  fila.appendChild(derecha);
  return fila;
}

async function registrarVenta(e) {
  e.preventDefault();
  const productoId = Number($("#venta-producto").value);
  const cantidad = Number($("#venta-cantidad").value);
  const fecha = $("#venta-fecha").value;

  const producto = productos.find((p) => p.id === productoId);
  if (!producto) return toast("Selecciona un producto.", "error");
  if (!cantidad || cantidad < 1) return toast("La cantidad debe ser mayor a 0.", "error");
  if (producto.stock < cantidad) {
    return toast("Stock insuficiente de " + producto.nombre + " (quedan " + producto.stock + ").", "error");
  }

  const venta = {
    producto_id: producto.id,
    nombre_producto: producto.nombre,
    cantidad: cantidad,
    precio_unitario: producto.precio,
    total: Math.round(producto.precio * cantidad * 100) / 100,
    fecha: fecha || hoyISO(),
  };

  await guardar(venta, "ventas");
  producto.stock -= cantidad;
  await guardar(producto, "productos");

  toast("Venta registrada: " + venta.nombre_producto + " x " + cantidad + " = " + formatearCOP(venta.total));
  await recargarTodo();
  notificarStockBajo();
}

async function eliminarVenta(id) {
  const venta = await leer(id, "ventas");
  if (!venta) return;

  if (!window.confirm("¿Eliminar esta venta? Se devolverá el stock al producto.")) return;

  const producto = productos.find((p) => p.id === venta.producto_id);
  if (producto) {
    producto.stock += venta.cantidad;
    await guardar(producto, "productos");
  }
  await eliminar(id, "ventas");
  toast("Venta eliminada y stock restaurado.");
  await recargarTodo();
}

// ---------------------------------------------------------------------------
// PRODUCTOS
// ---------------------------------------------------------------------------
function renderProductos() {
  let lista = productos.slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (terminoBusqueda) {
    const t = terminoBusqueda.toLowerCase();
    lista = lista.filter((p) => p.nombre.toLowerCase().includes(t) || p.categoria.toLowerCase().includes(t));
  }

  const caja = $("#lista-productos");
  caja.innerHTML = "";
  if (lista.length === 0) {
    caja.textContent = terminoBusqueda ? "No se encontraron productos." : "No hay productos. Pulsa + Nuevo para agregar el primero.";
  } else {
    lista.forEach((p) => caja.appendChild(crearFilaProducto(p)));
  }
}

function crearFilaProducto(p) {
  const fila = document.createElement("div");
  fila.className = "fila-lista";

  const emoji = document.createElement("span");
  emoji.className = "fila-emoji";
  emoji.textContent = p.emoji || "📦";

  const info = document.createElement("div");
  info.className = "fila-info";
  const nombre = document.createElement("div");
  nombre.className = "fila-nombre";
  nombre.textContent = p.nombre;
  const detalle = document.createElement("div");
  detalle.className = "fila-detalle";
  if (p.es_insumo) {
    const cu = costoUnidadInsumo(p);
    detalle.textContent = p.categoria + " · paquete: " + formatearCOP(p.costo) + " (" + formatearCOP(cu) + "/" + etiquetaUnidad(p.unidad) + ")";
  } else {
    detalle.textContent = p.categoria + " · " + formatearCOP(p.precio);
  }
  const insignia = document.createElement("span");
  const minimo = p.stock_minimo || 0;
  const unidad = etiquetaUnidad(p.unidad);
  if (p.es_insumo) {
    insignia.className = "insignia-stock " + (p.stock <= minimo ? "baja" : "media");
    insignia.textContent = (p.stock <= minimo ? "⚠️ " : "") + p.stock + " " + unidad + " · insumo";
  } else {
    insignia.className = "insignia-stock " + (p.stock <= 0 ? "baja" : p.stock <= minimo ? "baja" : "ok");
    insignia.textContent = p.stock <= 0 ? "AGOTADO" : p.stock + " " + unidad + " en stock";
  }
  info.appendChild(nombre);
  info.appendChild(detalle);
  info.appendChild(insignia);

  const derecha = document.createElement("div");
  derecha.className = "fila-derecha";
  const acciones = document.createElement("div");
  acciones.className = "acciones-fila";

  // Botón de receta solo para productos finales (los insumos no tienen receta).
  const btnReceta = document.createElement("button");
  btnReceta.className = "btn-mini";
  btnReceta.textContent = "📋";
  btnReceta.title = "Ver / editar receta";
  if (!p.es_insumo) {
    btnReceta.onclick = () => abrirModalReceta(p);
  } else {
    btnReceta.disabled = true;
    btnReceta.style.opacity = "0.35";
  }
  acciones.appendChild(btnReceta);

  const btnStock = document.createElement("button");
  btnStock.className = "btn-mini";
  btnStock.textContent = "+ Stock";
  btnStock.onclick = () => ajustarStock(p.id);

  const btnEditar = document.createElement("button");
  btnEditar.className = "btn-mini";
  btnEditar.textContent = "Editar";
  btnEditar.onclick = () => abrirModalProducto(p);

  const btnBorrar = document.createElement("button");
  btnBorrar.className = "btn-mini peligro";
  btnBorrar.textContent = "✕";
  btnBorrar.onclick = () => eliminarProducto(p.id);

  acciones.appendChild(btnStock);
  acciones.appendChild(btnEditar);
  acciones.appendChild(btnBorrar);
  derecha.appendChild(acciones);

  fila.appendChild(emoji);
  fila.appendChild(info);
  fila.appendChild(derecha);
  return fila;
}

// Emojis disponibles para marcar un producto (incluye comida, bebida y genéricos).
const EMOJIS_DISPONIBLES = [
  "🍰", "🎂", "🍫", "🍪", "🧁", "🍩", "🍮", "🍬", "🍭", "🍦",
  "🥧", "🍞", "🥐", "🥖", "🍕", "🍔", "🍟", "🌭", "🥪", "🌮",
  "🍜", "🍲", "🥗", "🥙", "🍤", "🥟", "🍱", "🍚", "🍝", "🍗",
  "🍖", "🥓", "🧀", "🥚", "🍳", "🥞", "🧇", "🥨", "🧂", "🥫",
  "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🍒", "🍑",
  "🥭", "🍍", "🥥", "🥝", "🍅", "🥑", "🥦", "🥬", "🥕", "🌽",
  "🍄", "🥔", "🧅", "🧄", "🥒", "🥜", "🍯", "🥛", "🍼", "☕",
  "🍵", "🧃", "🧉", "🍺", "🍷", "🥤", "🧊", "💧", "🧊",
  "🍇", "🍹", "🥂", "🍾", "🫖", "🧋",
  "📦", "🛒", "🛍️", "🛒", "🏪", "🏠", "🏢", "🏬", "🏭",
  "🧺", "🧴", "🧼", "🧽", "🧹", "🧻", "🧯", "🪣", "🪒", "💄",
  "💅", "🧖", "🛁", "🚿", "🪥", "👕", "👗", "👖", "🧥", "🧦",
  "👟", "👠", "👜", "🎒", "🧢", "🧣", "⌚", "📱", "💻", "🖥️",
  "🔌", "🔋", "💡", "🔦", "🔒", "🔑", "🛠️", "🔧", "🔨", "🧰",
  "⚙️", "🔩", "📏", "✂️", "📎", "📌", "🗒️", "📚", "📖", "✏️",
  "🖊️", "🖍️", "📅", "📆", "🗓️", "🖇️", "📐", "🧮", "🎁", "🎀",
  "🎈", "🎉", "🎊", "🪅", "🎃", "🎄", "🧸", "🪆", "🏆", "🥇",
  "🥈", "🥉", "⚽", "🏀", "⚾", "🏐", "🎱", "🏓", "🎾", "🎳",
  "⛸️", "🛹", "🚲", "🏍️", "🚗", "🚕", "🚌", "🚚", "🚛", "🚜",
  "🛵", "🚁", "✈️", "🚀", "🛶", "⛵", "🚢", "🧭", "🗺️", "📷",
  "🎥", "🎬", "🎧", "🎤", "🎹", "🥁", "🎻", "🎺", "🎸", "🎨",
  "🖌️", "🧵", "🧶", "🪡", "🪢", "👑", "💍", "💎", "🪙", "💵",
  "💳", "💰", "🪪", "🔍", "🧲", "🪜", "🪑", "🛏️", "🛋️", "🖼️",
  "🪞", "🪟", "🧱", "🪵", "🪴", "🌱", "🌿", "🌷", "🌹", "🌻",
  "🌸", "🌼", "🍀", "🌳", "🌲", "☘️", "🐶", "🐱", "🐭", "🐹",
  "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸",
  "🐵", "🐔", "🐧", "🐦", "🦆", "🦉", "🐣", "🐝", "🦋", "🐌",
  "🐢", "🐍", "🦎", "🐙", "🦑", "🦐", "🦞", "🦀", "🐟", "🐬",
  "🐳", "🦈", "🐚", "🦴", "🦷", "🧠", "👁️", "👀", "👂", "👃",
  "👄", "💋", "🫀", "🫁", "🦵", "🦶", "👋", "🤚", "✋", "🖐️",
  "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉",
  "👆", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏",
  "🙌", "👐", "🤲", "🤝", "🙏", "✍️", "💪", "🦾", "🦿", "🦻",
  "👂", "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂",
  "🙃", "🫠", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗",
  "😚", "😙", "🥲", "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗",
  "🤭", "🫢", "🫣", "🤫", "🤔", "🫡", "🤐", "🤨", "😐", "😑",
  "😶", "🫥", "😏", "😒", "🙄", "😬", "🤥", "😌", "😔", "😪",
  "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🥵", "🥶", "🥴",
  "😵", "🤯", "🤠", "🥳", "🥸", "😎", "🤓", "🧐", "😕", "🫤",
  "😟", "🙁", "😮", "🤯", "😲", "😳", "🥺", "😦", "😧", "😨",
  "😰", "😥", "😢", "😭", "😱", "😖", "😣", "😞", "😓", "😩",
  "😫", "🥱", "😤", "😡", "😠", "🤬", "😈", "👿", "💀", "☠️",
  "💩", "🤡", "👹", "👺", "👻", "👽", "👾", "🤖", "😺", "😸",
  "😹", "😻", "😼", "😽", "🙀", "😿", "😾", "❤️", "🧡", "💛",
  "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❣️", "💕", "💞",
  "💓", "💗", "💖", "💘", "💝", "💟", "☮️", "✝️", "☪️", "🕉️",
  "☸️", "✡️", "🔯", "🕎", "☯️", "☦️", "🛐", "⛎", "♈", "♉",
  "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓",
  "🆕", "🆙", "🆒", "🆓", "🆖", "🆗", "🆘", "🆚", "🈁", "🈂️",
  "🈷️", "🈶", "🈯", "🉐", "🈹", "🈚", "🈲", "🉑", "🈸", "🈴",
  "🈳", "㊗️", "㊙️", "🈺", "🈵", "🔴", "🟠", "🟡", "🟢", "🔵",
  "🟣", "🟤", "⚫", "⚪", "🟥", "🟧", "🟨", "🟩", "🟦", "🟪",
  "🟫", "⬛", "⬜", "◼️", "◻️", "◾", "◽", "▪️", "▫️", "🔶",
  "🔷", "🔸", "🔹", "🔺", "🔻", "💠", "🔘", "🔳", "🔲", "🟰",
  "⭐", "🌟", "✨", "⚡", "🔥", "💥", "💫", "💦", "💨", "🕳️",
  "💣", "☄️", "🌋", "🌊", "🌈", "☀️", "🌤️", "⛅", "🌥️", "☁️",
  "🌦️", "🌧️", "⛈️", "🌨️", "❄️", "☃️", "⛄", "🌬️", "💨", "🌪️",
  "🌫️", "🌁", "🌂", "☂️", "🧵", "🌡️", "🧤", "🧦", "🧢", "🪖",
];

// Llena el selector de emojis conservando la selección actual (si existe).
function llenarSelectEmoji(select, valorActual) {
  const actual = valorActual && valorActual.trim() ? valorActual : "🍰";
  select.innerHTML = "";
  const opciones = [];
  if (!EMOJIS_DISPONIBLES.includes(actual)) opciones.push(actual);
  opciones.push(...EMOJIS_DISPONIBLES);
  opciones.forEach((e) => {
    const op = document.createElement("option");
    op.value = e;
    op.textContent = e + "  " + nombreEmoji(e);
    select.appendChild(op);
  });
  select.value = opciones.includes(actual) ? actual : "🍰";
}

// Nombre descriptivo (aproximado) para cada emoji en el selector.
function nombreEmoji(emoji) {
  const nombres = {
    "🍰": "Pastel", "🎂": "Torta", "🍫": "Chocolate", "🍪": "Galletas", "🧁": "Cupcake",
    "🍩": "Dona", "🍮": "Flan", "🍬": "Dulce", "🍭": "Paleta", "🍦": "Helado",
    "🥧": "Pay", "🍞": "Pan", "🥐": "Croissant", "🥖": "Baguette", "🍕": "Pizza",
    "🍔": "Hamburguesa", "🍟": "Papas", "🌭": "Perro caliente", "🥪": "Sándwich", "🌮": "Taco",
    "🥚": "Huevos", "🥛": "Leche", "🍯": "Miel", "🧀": "Queso", "🧈": "Mantequilla",
    "☕": "Café", "🍵": "Té", "🧃": "Jugo", "🧋": "Bubble tea", "🥤": "Gaseosa",
    "🍹": "Cóctel", "🥂": "Brindis", "🍾": "Champán", "🍷": "Vino", "🍺": "Cerveza",
    "📦": "Caja", "🛒": "Carrito", "🛍️": "Compras", "🏪": "Tienda", "🏠": "Casa",
    "🏬": "Local", "🏭": "Fábrica", "🧺": "Cesta", "🧴": "Botella", "🧼": "Jabón",
    "🧽": "Esponja", "🧹": "Escoba", "🧻": "Papel", "🧯": "Extintor", "🧯": "Extintor",
    "💄": "Labial", "💅": "Uñas", "🛁": "Baño", "🚿": "Ducha", "🪥": "Cepillo",
    "👕": "Camiseta", "👗": "Vestido", "👖": "Pantalón", "🧥": "Chaqueta", "🧦": "Medias",
    "👟": "Zapatos", "👠": "Tacones", "👜": "Bolso", "🎒": "Mochila", "🧢": "Gorra",
    "⌚": "Reloj", "📱": "Celular", "💻": "Computador", "🔌": "Cargador", "🔋": "Batería",
    "💡": "Bombillo", "🔒": "Candado", "🔑": "Llave", "🛠️": "Herramientas", "🔧": "Llave inglesa",
    "🔨": "Martillo", "🧰": "Caja de herramientas", "⚙️": "Engranaje", "🔩": "Tornillo",
    "📏": "Regla", "✂️": "Tijeras", "📎": "Clip", "📌": "Chinche", "📚": "Libros",
    "📖": "Libro", "✏️": "Lápiz", "🖊️": "Pluma", "📅": "Calendario", "🎁": "Regalo",
    "🎀": "Moño", "🎈": "Globo", "🎉": "Fiesta", "🎊": "Confeti", "🎃": "Calabaza",
    "🎄": "Navidad", "🧸": "Peluche", "🏆": "Trofeo", "🥇": "Medalla oro", "🥈": "Medalla plata",
    "🥉": "Medalla bronce", "⚽": "Fútbol", "🏀": "Baloncesto", "🏐": "Voleibol", "🎱": "Billar",
    "🏓": "Ping pong", "🎾": "Tenis", "🎳": "Boliche", "🛹": "Patineta", "🚲": "Bicicleta",
    "🚗": "Carro", "🚌": "Bus", "🚚": "Camión", "🚜": "Tractor", "🚁": "Helicóptero",
    "✈️": "Avión", "🚀": "Cohete", "⛵": "Velero", "🚢": "Barco", "🗺️": "Mapa",
    "📷": "Cámara", "🎥": "Video", "🎧": "Audífonos", "🎤": "Micrófono", "🎹": "Piano",
    "🥁": "Tambor", "🎻": "Violín", "🎺": "Trompeta", "🎸": "Guitarra", "🎨": "Arte",
    "🧵": "Hilo", "🧶": "Lana", "👑": "Corona", "💍": "Anillo", "💎": "Diamante",
    "🪙": "Moneda", "💵": "Dinero", "💳": "Tarjeta", "💰": "Bolsa de dinero", "🪪": "Carné",
    "🔍": "Lupa", "🪑": "Silla", "🛏️": "Cama", "🛋️": "Sofá", "🖼️": "Cuadro",
    "🪞": "Espejo", "🪟": "Ventana", "🧱": "Ladrillo", "🪴": "Planta", "🌱": "Brote",
    "🌿": "Hierba", "🌷": "Tulipán", "🌹": "Rosa", "🌻": "Girasol", "🌸": "Flor",
    "🌼": "Margarita", "🍀": "Trébol", "🌳": "Árbol", "🌲": "Pino", "🐶": "Perro",
    "🐱": "Gato", "🐭": "Ratón", "🐹": "Hámster", "🐰": "Conejo", "🦊": "Zorro",
    "🐻": "Oso", "🐼": "Panda", "🐯": "Tigre", "🦁": "León", "🐮": "Vaca",
    "🐷": "Cerdo", "🐸": "Rana", "🐵": "Mono", "🐔": "Gallina", "🐧": "Pingüino",
    "🐦": "Pájaro", "🦉": "Búho", "🐣": "Pollito", "🐝": "Abeja", "🦋": "Mariposa",
    "🐌": "Caracol", "🐢": "Tortuga", "🐍": "Serpiente", "🦎": "Lagartija", "🐙": "Pulpo",
    "🦐": "Camarón", "🦀": "Cangrejo", "🐟": "Pez", "🐬": "Delfín", "🐳": "Ballena",
    "🦈": "Tiburón", "🐚": "Concha", "🦴": "Hueso", "🧠": "Cerebro", "👀": "Ojos",
    "💪": "Músculo", "👋": "Saludo", "🤝": "Apretón", "🙏": "Gracias", "👍": "Pulgar arriba",
    "👎": "Pulgar abajo", "👏": "Aplausos", "🙌": "Celebración", "✌️": "Victoria", "🤘": "Rock",
    "😀": "Feliz", "😂": "Risas", "🤣": "Carcajada", "😍": "Enamorado", "😎": "Genial",
    "🤩": "Asombrado", "🥳": "Fiestero", "🤔": "Pensando", "😴": "Dormido", "😷": "Enfermo",
    "🥵": "Calor", "🥶": "Frío", "😱": "Susto", "😢": "Triste", "😡": "Enojado",
    "💀": "Calavera", "👻": "Fantasma", "👽": "Alien", "🤖": "Robot", "💩": "Caca",
    "❤️": "Corazón", "💙": "Corazón azul", "💚": "Corazón verde", "💜": "Corazón morado", "🖤": "Corazón negro",
    "💔": "Corazón roto", "💖": "Corazón brillante", "⭐": "Estrella", "🌟": "Estrella brillante", "✨": "Brillo",
    "⚡": "Rayo", "🔥": "Fuego", "💥": "Explosión", "💫": "Meteoro", "💦": "Gotas",
    "💨": "Viento", "🌈": "Arcoíris", "☀️": "Sol", "⛅": "Nublado", "🌧️": "Lluvia",
    "❄️": "Nieve", "⛄": "Muñeco de nieve", "🌪️": "Tornado", "🌊": "Ola", "🌋": "Volcán",
    "☮️": "Paz", "⚽": "Fútbol", "🔴": "Rojo", "🟠": "Naranja", "🟡": "Amarillo",
    "🟢": "Verde", "🔵": "Azul", "🟣": "Morado", "🟤": "Café", "⚫": "Negro",
    "⚪": "Blanco", "💠": "Rombo", "🔘": "Botón", "🆕": "Nuevo", "🆗": "OK",
    "❌": "Equis", "⭕": "Círculo", "✅": "Listo", "❗": "Exclamación", "❓": "Interrogación",
  };
  return nombres[emoji] || "";
}

function abrirModalProducto(p) {
  // Llenamos el selector de categorías con las categorías guardadas.
  const selectCategoria = $("#producto-categoria");
  const categoriaAnterior = p ? p.categoria : "";
  selectCategoria.innerHTML = "";
  categorias.forEach((c) => {
    const op = document.createElement("option");
    op.value = c.nombre;
    op.textContent = c.nombre;
    selectCategoria.appendChild(op);
  });

  $("#modal-producto-titulo").textContent = p ? "Editar producto" : "Nuevo producto";
  $("#producto-id").value = p ? p.id : "";
  $("#producto-nombre").value = p ? p.nombre : "";
  $("#producto-categoria").value = categoriaAnterior || (categorias[0] ? categorias[0].nombre : "Otros");
  $("#producto-precio").value = p ? p.precio : "";
  $("#producto-costo").value = p ? p.costo : "";
  $("#producto-stock").value = p ? p.stock : "";
  $("#producto-stock-minimo").value = p ? p.stock_minimo : 3;
  $("#producto-unidad").value = p && p.unidad ? p.unidad : "unidad";
  llenarSelectEmoji($("#producto-emoji"), p ? p.emoji : "🍰");
  $("#producto-es-insumo").checked = p ? !!p.es_insumo : false;

  // Si el producto tiene receta, mostramos el costo automático según sus insumos.
  const costoAuto = p ? calcularCostoProducto(p.id) : 0;
  const notaCosto = $("#producto-costo-nota");
  if (costoAuto > 0 && p) {
    notaCosto.textContent = "Auto: " + formatearCOP(costoAuto) + " (según receta)";
    notaCosto.classList.remove("oculto");
    $("#producto-costo").value = costoAuto;
  } else {
    notaCosto.classList.add("oculto");
  }

  actualizarCampoPrecioInsumo();
  actualizarCampoCostoInsumo();

  $("#modal-producto").classList.remove("oculto");
}

// El campo "Costo" siempre se muestra (los insumos no tienen receta; su costo es manual).
function actualizarCampoCostoInsumo() {
  const campo = $("#campo-costo");
  const input = $("#producto-costo");
  const notaCosto = $("#producto-costo-nota");
  const labelTexto = $("#costo-label-texto");
  campo.classList.remove("oculto");
  input.setAttribute("required", "");
  const esInsumo = $("#producto-es-insumo").checked;
  const unidad = $("#producto-unidad").value;
  const stock = Number($("#producto-stock").value);
  if (esInsumo) {
    if (labelTexto) labelTexto.textContent = "Costo total del paquete";
    if (stock > 0) {
      const total = Number($("#producto-costo").value) || 0;
      notaCosto.textContent = "Costo por " + etiquetaUnidad(unidad) + ": $ " + (total / stock).toLocaleString("es-CO", { maximumFractionDigits: 2 });
      notaCosto.classList.remove("oculto");
    } else {
      notaCosto.classList.add("oculto");
    }
  } else {
    if (labelTexto) labelTexto.textContent = "Costo";
    notaCosto.classList.add("oculto");
  }
}

// Oculta/requiere el campo "Precio de venta" según si el producto es insumo.
function actualizarCampoPrecioInsumo() {
  const esInsumo = $("#producto-es-insumo").checked;
  const campo = $("#campo-precio-venta");
  const input = $("#producto-precio");
  if (esInsumo) {
    campo.classList.add("oculto");
    input.removeAttribute("required");
    input.value = "0";
  } else {
    campo.classList.remove("oculto");
    input.setAttribute("required", "");
  }
}

async function guardarProducto(e) {
  e.preventDefault();
  const id = $("#producto-id").value;
  const nombre = $("#producto-nombre").value.trim();
  const categoria = $("#producto-categoria").value;
  const precio = Number($("#producto-precio").value);
  const costo = Number($("#producto-costo").value);
  const stock = Number($("#producto-stock").value);
  const stockMinimo = Number($("#producto-stock-minimo").value);
  const unidad = $("#producto-unidad").value;
  const emoji = $("#producto-emoji").value.trim();

  if (!nombre) return toast("El nombre es obligatorio.", "error");
  if (isNaN(precio) || isNaN(costo)) return toast("Precio y costo deben ser números.", "error");

  const esInsumo = $("#producto-es-insumo").checked;
  // Para insumos el campo "Costo" es el total del paquete; derivamos el costo
  // por unidad dividiendo entre el stock.
  const costoUnidad = (esInsumo && stock > 0) ? costo / stock : costo;
  const datos = { nombre, categoria, precio, costo, costo_unidad: costoUnidad, stock, stock_minimo: stockMinimo, unidad, emoji: emoji || "📦", es_insumo: esInsumo };
  if (id) {
    const anterior = productos.find((p) => p.id === Number(id));
    datos.id = Number(id);
    await guardar(datos, "productos");
    // Si el producto ahora es insumo, su receta ya no tiene sentido.
    if (esInsumo && anterior && !anterior.es_insumo) {
      await limpiarRecetasDeProducto(datos.id);
    }
    toast("Producto actualizado.");
  } else {
    await guardar(datos, "productos");
    toast("Producto agregado.");
  }
  cerrarModalProducto();
  await recargarTodo();

  // Si cambió el costo de un insumo, actualizamos el costo de los productos que lo usan.
  if (esInsumo && id) {
    const usanEsteInsumo = recetas.filter((r) => r.insumo_id === Number(id)).map((r) => r.producto_id);
    let algunCambio = false;
    for (const pid of usanEsteInsumo) {
      if (await actualizarCostoProducto(pid)) algunCambio = true;
    }
    if (algunCambio) await recargarTodo();
  }
}

async function limpiarRecetasDeProducto(productoId) {
  const aEliminar = recetas.filter((r) => r.producto_id === productoId || r.insumo_id === productoId);
  for (const r of aEliminar) {
    await eliminar(r.id, "recetas");
  }
  recetas = recetas.filter((r) => r.producto_id !== productoId && r.insumo_id !== productoId);
}

function cerrarModalProducto() {
  $("#modal-producto").classList.add("oculto");
  $("#form-producto").reset();
}

async function eliminarProducto(id) {
  const p = productos.find((x) => x.id === id);
  if (!p) return;
  if (!window.confirm("¿Eliminar el producto '" + p.nombre + "'? Las ventas registradas se conservan.")) return;
  await eliminar(id, "productos");
  // Limpiamos las recetas que usan este producto como producto o insumo.
  await limpiarRecetasDeProducto(id);
  toast("Producto eliminado.");
  await recargarTodo();
}

async function ajustarStock(id) {
  const p = productos.find((x) => x.id === id);
  if (!p) return;
  const valor = window.prompt("Stock actual de " + p.nombre + ": " + p.stock + " " + etiquetaUnidad(p.unidad) + "\nEscribe la nueva cantidad:", String(p.stock));
  if (valor === null) return;
  const nuevo = Number(valor);
  if (isNaN(nuevo) || nuevo < 0) return toast("Cantidad inválida.", "error");
  p.stock = nuevo;
  await guardar(p, "productos");
  toast("Stock de " + p.nombre + " actualizado a " + nuevo + " " + etiquetaUnidad(p.unidad));
  await recargarTodo();
  notificarStockBajo();
}

// ---------------------------------------------------------------------------
// CATEGORÍAS (CRUD)
// ---------------------------------------------------------------------------
function abrirModalCategorias() {
  renderListaCategorias();
  $("#categoria-id").value = "";
  $("#categoria-nombre").value = "";
  $("#btn-guardar-categoria").textContent = "Agregar";
  $("#modal-categorias").classList.remove("oculto");
}

function cerrarModalCategorias() {
  $("#modal-categorias").classList.add("oculto");
  $("#form-categoria").reset();
}

function renderListaCategorias() {
  const caja = $("#lista-categorias");
  caja.innerHTML = "";

  if (categorias.length === 0) {
    caja.textContent = "No hay categorías. Agrega una arriba.";
    return;
  }

  categorias.slice().sort((a, b) => a.nombre.localeCompare(b.nombre)).forEach((c) => {
    const fila = document.createElement("div");
    fila.className = "fila-lista";

    const emoji = document.createElement("span");
    emoji.className = "fila-emoji";
    emoji.textContent = "🗂️";

    const info = document.createElement("div");
    info.className = "fila-info";
    const nombre = document.createElement("div");
    nombre.className = "fila-nombre";
    nombre.textContent = c.nombre;
    const detalle = document.createElement("div");
    detalle.className = "fila-detalle";
    const usados = productos.filter((p) => p.categoria === c.nombre).length;
    detalle.textContent = usados + " producto(s)";
    info.appendChild(nombre);
    info.appendChild(detalle);

    const acciones = document.createElement("div");
    acciones.className = "acciones-fila";

    const btnEditar = document.createElement("button");
    btnEditar.className = "btn-mini";
    btnEditar.textContent = "Editar";
    btnEditar.onclick = () => editarCategoria(c);

    const btnBorrar = document.createElement("button");
    btnBorrar.className = "btn-mini peligro";
    btnBorrar.textContent = "✕";
    btnBorrar.onclick = () => eliminarCategoria(c.id);

    acciones.appendChild(btnEditar);
    acciones.appendChild(btnBorrar);

    fila.appendChild(emoji);
    fila.appendChild(info);
    fila.appendChild(acciones);
    caja.appendChild(fila);
  });
}

function editarCategoria(c) {
  $("#categoria-id").value = c.id;
  $("#categoria-nombre").value = c.nombre;
  $("#btn-guardar-categoria").textContent = "Actualizar";
  $("#categoria-nombre").focus();
}

async function guardarCategoria(e) {
  e.preventDefault();
  const id = $("#categoria-id").value;
  const nombre = $("#categoria-nombre").value.trim();
  if (!nombre) return toast("Escribe un nombre para la categoría.", "error");

  const duplicada = categorias.find((c) => c.nombre.toLowerCase() === nombre.toLowerCase() && String(c.id) !== id);
  if (duplicada) return toast("Ya existe una categoría con ese nombre.", "error");

  if (id) {
    // Renombrar: actualizamos la categoría y los productos que la usaban.
    const categoria = categorias.find((c) => c.id === Number(id));
    const nombreAnterior = categoria ? categoria.nombre : "";
    categoria.nombre = nombre;
    await guardar(categoria, "categorias");

    if (nombreAnterior && nombreAnterior !== nombre) {
      for (const p of productos.filter((p) => p.categoria === nombreAnterior)) {
        p.categoria = nombre;
        await guardar(p, "productos");
      }
    }
    toast("Categoría actualizada.");
  } else {
    await guardar({ nombre }, "categorias");
    toast("Categoría agregada.");
  }

  await recargarTodo();
  renderListaCategorias();
  $("#categoria-id").value = "";
  $("#categoria-nombre").value = "";
  $("#btn-guardar-categoria").textContent = "Agregar";
}

async function eliminarCategoria(id) {
  const categoria = categorias.find((c) => c.id === id);
  if (!categoria) return;

  const usados = productos.filter((p) => p.categoria === categoria.nombre).length;
  const aviso = usados > 0
    ? "La categoría '" + categoria.nombre + "' tiene " + usados + " producto(s) que se moverán a 'Otros'."
    : "¿Eliminar la categoría '" + categoria.nombre + "'?";
  if (!window.confirm(aviso + "\n¿Continuar?")) return;

  // Nos aseguramos de que exista una categoría "Otros" como destino.
  if (usados > 0) {
    let otros = categorias.find((c) => c.nombre === "Otros");
    if (!otros) {
      otros = { nombre: "Otros" };
      await guardar(otros, "categorias");
    }
    for (const p of productos.filter((p) => p.categoria === categoria.nombre)) {
      p.categoria = "Otros";
      await guardar(p, "productos");
    }
  }

  await eliminar(id, "categorias");
  toast("Categoría eliminada.");
  await recargarTodo();
  renderListaCategorias();
}

// ---------------------------------------------------------------------------
// RECETAS (ingredientes de cada producto)
// ---------------------------------------------------------------------------
function abrirModalReceta(p) {
  productoRecetaActual = p;
  $("#receta-titulo").textContent = "📋 Receta de " + p.nombre;
  $("#receta-subtitulo").textContent = "Ingredientes necesarios para hacer una unidad (la cantidad usa la unidad de cada insumo). Puedes agregar, editar o eliminar ingredientes.";

  // Selector de insumos (solo productos marcados como insumo, excepto este mismo).
  const select = $("#receta-insumo");
  select.innerHTML = "";
  const insumos = productos.filter((x) => x.es_insumo && x.id !== p.id).sort((a, b) => a.nombre.localeCompare(b.nombre));
  insumos.forEach((i) => {
    const op = document.createElement("option");
    op.value = i.id;
    op.textContent = i.emoji + " " + i.nombre + " (stock: " + i.stock + " " + etiquetaUnidad(i.unidad) + ")";
    select.appendChild(op);
  });

  renderListaReceta();
  $("#receta-insumo-id-edicion").value = "";
  $("#receta-insumo").disabled = false;
  $("#receta-cantidad").value = "";
  $("#btn-guardar-receta").textContent = "Agregar";
  $("#modal-receta").classList.remove("oculto");
}

function cerrarModalReceta() {
  $("#modal-receta").classList.add("oculto");
  productoRecetaActual = null;
  $("#form-receta").reset();
}

// Costo por unidad (gramo/ml/pieza) de un insumo.
// El campo "Costo" guarda el total del paquete, así que se divide entre el stock
// para obtener el costo por unidad de medida.
function costoUnidadInsumo(insumo) {
  if (!insumo) return 0;
  if (insumo.costo_unidad !== undefined && insumo.costo_unidad !== null) return Number(insumo.costo_unidad) || 0;
  if (insumo.es_insumo && insumo.stock > 0) return (Number(insumo.costo) || 0) / insumo.stock;
  return Number(insumo.costo) || 0;
}

// Calcula el costo por unidad de un producto sumando insumo.costo_unidad × cantidad de su receta.
function calcularCostoProducto(productoId) {
  const ingredientes = recetas.filter((r) => r.producto_id === productoId);
  return Math.round(ingredientes.reduce((acc, r) => {
    const insumo = productos.find((p) => p.id === r.insumo_id);
    return acc + (costoUnidadInsumo(insumo) * (Number(r.cantidad) || 0));
  }, 0));
}

// Actualiza el costo del producto según su receta y lo guarda si cambió.
// También recalcula en cadena los productos que usan este como insumo.
async function actualizarCostoProducto(productoId) {
  const visitados = new Set();
  const cola = [productoId];
  let cambio = false;
  while (cola.length) {
    const pid = cola.pop();
    if (visitados.has(pid)) continue;
    visitados.add(pid);
    const producto = productos.find((p) => p.id === pid);
    if (!producto) continue;
    const nuevo = calcularCostoProducto(pid);
    if (nuevo > 0 && producto.costo !== nuevo) {
      producto.costo = nuevo;
      await guardar(producto, "productos");
      cambio = true;
    }
    recetas.filter((r) => r.insumo_id === pid).forEach((r) => cola.push(r.producto_id));
  }
  return cambio;
}

function renderListaReceta() {
  const caja = $("#lista-receta");
  caja.innerHTML = "";

  if (!productoRecetaActual) return;
  const ingredientes = recetas.filter((r) => r.producto_id === productoRecetaActual.id);

  if (ingredientes.length === 0) {
    caja.textContent = "Este producto aún no tiene receta. Agrega los insumos que necesitas.";
  }

  ingredientes.forEach((r) => {
    const insumo = productos.find((p) => p.id === r.insumo_id);
    if (!insumo) return;

    const fila = document.createElement("div");
    fila.className = "fila-lista";

    const emoji = document.createElement("span");
    emoji.className = "fila-emoji";
    emoji.textContent = insumo.emoji || "🧺";

    const info = document.createElement("div");
    info.className = "fila-info";
    const nombre = document.createElement("div");
    nombre.className = "fila-nombre";
    nombre.textContent = insumo.nombre;
    const detalle = document.createElement("div");
    detalle.className = "fila-detalle";
    const suficiente = insumo.stock >= r.cantidad;
    detalle.textContent = r.cantidad + " " + etiquetaUnidad(insumo.unidad) + " · stock: " + insumo.stock + " " + etiquetaUnidad(insumo.unidad) + (suficiente ? "" : " ⚠️ insuficiente");
    info.appendChild(nombre);
    info.appendChild(detalle);

    const acciones = document.createElement("div");
    acciones.className = "acciones-fila";

    const btnEditar = document.createElement("button");
    btnEditar.className = "btn-mini";
    btnEditar.textContent = "Editar";
    btnEditar.title = "Editar ingrediente o cantidad";
    btnEditar.onclick = () => editarReceta(r);

    const btnBorrar = document.createElement("button");
    btnBorrar.className = "btn-mini peligro";
    btnBorrar.textContent = "✕";
    btnBorrar.title = "Eliminar ingrediente";
    btnBorrar.onclick = () => eliminarReceta(r.id);

    acciones.appendChild(btnEditar);
    acciones.appendChild(btnBorrar);

    fila.appendChild(emoji);
    fila.appendChild(info);
    fila.appendChild(acciones);
    caja.appendChild(fila);
  });

  const costo = calcularCostoProducto(productoRecetaActual.id);
  const pie = document.createElement("div");
  pie.className = "costo-receta";
  pie.textContent = costo > 0
    ? "Costo automático por unidad: " + formatearCOP(costo)
    : "Costo automático: calcula según los insumos que agregues";
  caja.appendChild(pie);
}

function editarReceta(r) {
  $("#receta-insumo-id-edicion").value = r.id;
  $("#receta-insumo").value = r.insumo_id;
  $("#receta-insumo").disabled = false;
  $("#receta-cantidad").value = r.cantidad;
  $("#btn-guardar-receta").textContent = "Actualizar";
  $("#receta-cantidad").focus();
}

async function guardarReceta(e) {
  e.preventDefault();
  if (!productoRecetaActual) return;

  const insumoId = Number($("#receta-insumo").value);
  const cantidad = Number($("#receta-cantidad").value);
  if (!insumoId) return toast("Selecciona un insumo.", "error");
  if (!cantidad || cantidad <= 0) return toast("La cantidad debe ser mayor a 0.", "error");

  const edicionId = $("#receta-insumo-id-edicion").value;

  if (edicionId) {
    const receta = recetas.find((r) => r.id === Number(edicionId));
    if (!receta) return;
    // Evitar duplicados (mismo insumo en la misma receta, excepto esta).
    const duplicada = recetas.find((r) =>
      r.producto_id === productoRecetaActual.id &&
      r.insumo_id === insumoId &&
      String(r.id) !== edicionId
    );
    if (duplicada) return toast("Ese insumo ya está en la receta.", "error");
    receta.insumo_id = insumoId;
    receta.cantidad = cantidad;
    await guardar(receta, "recetas");
  } else {
    // Evitar duplicados (mismo insumo en la misma receta).
    const duplicada = recetas.find((r) =>
      r.producto_id === productoRecetaActual.id &&
      r.insumo_id === insumoId
    );
    if (duplicada) return toast("Ese insumo ya está en la receta. Usa Editar para cambiar su cantidad.", "error");
    await guardar({ producto_id: productoRecetaActual.id, insumo_id: insumoId, cantidad }, "recetas");
  }

  await recargarTodo();
  await actualizarCostoProducto(productoRecetaActual.id);
  const costo = calcularCostoProducto(productoRecetaActual.id);
  toast((edicionId ? "Ingrediente actualizado." : "Ingrediente agregado a la receta.") + (costo > 0 ? " Costo automático: " + formatearCOP(costo) : ""));
  renderListaReceta();
  $("#receta-insumo-id-edicion").value = "";
  $("#receta-insumo").disabled = false;
  $("#receta-cantidad").value = "";
  $("#btn-guardar-receta").textContent = "Agregar";
}

async function eliminarReceta(id) {
  if (!window.confirm("¿Quitar este ingrediente de la receta?")) return;
  await eliminar(id, "recetas");
  toast("Ingrediente quitado.");
  await recargarTodo();
  await actualizarCostoProducto(productoRecetaActual.id);
  renderListaReceta();
}

// ---------------------------------------------------------------------------
// PRODUCIR
// ---------------------------------------------------------------------------
function renderProducir() {
  // Selector de productos (solo productos finales; los insumos no se producen).
  const select = $("#producir-producto");
  const anterior = select.value;
  select.innerHTML = "";
  const producibles = productos
    .filter((p) => !p.es_insumo)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  producibles.forEach((p) => {
    const op = document.createElement("option");
    op.value = p.id;
    op.textContent = p.emoji + " " + p.nombre;
    select.appendChild(op);
  });
  if (anterior) select.value = anterior;

  calcularNecesidades();
  renderListaCompras();
}

function calcularNecesidades() {
  const caja = $("#necesidades-produccion");
  const btnRegistrar = $("#btn-registrar-produccion");

  const productoId = Number($("#producir-producto").value);
  const cantidad = 1;
  const producto = productos.find((p) => p.id === productoId);

  if (!producto) {
    caja.innerHTML = "Elige un producto para ver sus insumos.";
    btnRegistrar.classList.add("oculto");
    produccionSeleccionada = null;
    return;
  }

  const ingredientes = recetas.filter((r) => r.producto_id === productoId);

  if (ingredientes.length === 0) {
    caja.innerHTML = "El producto <b>" + producto.nombre + "</b> no tiene receta. Defínela con el botón 📋 en Productos.";
    btnRegistrar.classList.add("oculto");
    produccionSeleccionada = null;
    return;
  }

  caja.innerHTML = "";
  const tabla = document.createElement("div");
  const encabezado = document.createElement("div");
  encabezado.className = "fila-detalle";
  encabezado.style.marginBottom = "6px";
  encabezado.style.fontWeight = "bold";
  encabezado.style.fontSize = "16px";
  encabezado.textContent = producto.nombre + " — ingredientes y cantidades";
  tabla.appendChild(encabezado);

  const requerimientos = [];

  ingredientes.forEach((r) => {
    const insumo = productos.find((p) => p.id === r.insumo_id);
    if (!insumo) return;
    const requerido = r.cantidad * cantidad;
    const faltante = Math.max(0, requerido - insumo.stock);
    requerimientos.push({ receta: r, insumo, requerido, faltante });

    const fila = document.createElement("div");
    fila.className = "fila-lista fila-necesidad";

    const emoji = document.createElement("span");
    emoji.className = "fila-emoji";
    emoji.textContent = insumo.emoji || "🧺";

    const info = document.createElement("div");
    info.className = "fila-info";
    const nombre = document.createElement("div");
    nombre.className = "fila-nombre";
    nombre.textContent = insumo.nombre;
    const detalle = document.createElement("div");
    detalle.className = "fila-detalle";
    detalle.textContent = r.cantidad + " " + etiquetaUnidad(insumo.unidad);
    info.appendChild(nombre);
    info.appendChild(detalle);

    const derecha = document.createElement("div");
    derecha.className = "fila-derecha";

    const estado = document.createElement("span");
    estado.className = "insignia-stock " + (faltante > 0 ? "baja" : "ok");
    estado.textContent = faltante > 0 ? "Faltan " + faltante + " " + etiquetaUnidad(insumo.unidad) : "OK";
    derecha.appendChild(estado);

    fila.appendChild(emoji);
    fila.appendChild(info);
    fila.appendChild(derecha);
    tabla.appendChild(fila);
  });

  caja.appendChild(tabla);

  produccionSeleccionada = { producto, cantidad, requerimientos };

  btnRegistrar.classList.remove("oculto");
  const todoSuficiente = requerimientos.every((x) => x.faltante === 0);
  btnRegistrar.disabled = !todoSuficiente;
  btnRegistrar.textContent = todoSuficiente
    ? "Registrar producción de " + producto.nombre
    : "Faltan insumos para producir";
}

async function registrarProduccion() {
  const productoId = Number($("#producir-producto").value);
  const cantidad = 1;
  const producto = productos.find((p) => p.id === productoId);
  if (!producto) return;

  const requerimientos = [];
  let todoSuficiente = true;
  recetas.filter((r) => r.producto_id === productoId).forEach((r) => {
    const insumo = productos.find((p) => p.id === r.insumo_id);
    if (!insumo) return;
    const porUnidad = Math.max(0, Number(r.cantidad) || 0);
    if (porUnidad <= 0) return;
    const requerido = porUnidad * cantidad;
    const faltante = Math.max(0, requerido - insumo.stock);
    if (faltante > 0) todoSuficiente = false;
    requerimientos.push({ insumo, requerido, faltante });
  });

  if (requerimientos.length === 0) return toast("Agrega al menos un insumo con cantidad mayor a 0.", "error");
  if (!todoSuficiente) return toast("No hay suficientes insumos para producir.", "error");

  if (!window.confirm("Producir " + cantidad + " × " + producto.nombre + "?\nSe descontarán los insumos y aumentará el stock del producto.")) return;

  for (const { insumo, requerido } of requerimientos) {
    insumo.stock = Math.max(0, insumo.stock - requerido);
    await guardar(insumo, "productos");
  }
  producto.stock = (producto.stock || 0) + cantidad;
  await guardar(producto, "productos");

  toast("Producción registrada: " + cantidad + " × " + producto.nombre);
  await recargarTodo();
  calcularNecesidades();
  notificarStockBajo();
}

// Lista de compras: insumos con stock por debajo de su mínimo.
function renderListaCompras() {
  const caja = $("#lista-compras");
  caja.innerHTML = "";

  const insumos = productos.filter((p) => p.es_insumo);
  const compras = insumos
    .map((i) => ({ insumo: i, faltante: Math.max(0, (i.stock_minimo || 0) - i.stock) }))
    .filter((c) => c.faltante > 0)
    .sort((a, b) => b.faltante - a.faltante);

  if (compras.length === 0) {
    caja.innerHTML = '<span style="color:#16a34a">✅ Todos los insumos están por encima de su stock mínimo.</span>';
    return;
  }

  compras.forEach(({ insumo, faltante }) => {
    const fila = document.createElement("div");
    fila.className = "fila-lista";

    const emoji = document.createElement("span");
    emoji.className = "fila-emoji";
    emoji.textContent = insumo.emoji || "🧺";

    const info = document.createElement("div");
    info.className = "fila-info";
    const nombre = document.createElement("div");
    nombre.className = "fila-nombre";
    nombre.textContent = insumo.nombre;
    const detalle = document.createElement("div");
    detalle.className = "fila-detalle";
    detalle.textContent = "Tienes " + insumo.stock + " " + etiquetaUnidad(insumo.unidad) + " de " + (insumo.stock_minimo || 0) + " " + etiquetaUnidad(insumo.unidad) + " mínimo";
    info.appendChild(nombre);
    info.appendChild(detalle);

    const derecha = document.createElement("div");
    derecha.className = "fila-derecha";
    const estado = document.createElement("span");
    estado.className = "insignia-stock baja";
    estado.textContent = "Comprar " + faltante + " " + etiquetaUnidad(insumo.unidad);
    derecha.appendChild(estado);

    fila.appendChild(emoji);
    fila.appendChild(info);
    fila.appendChild(derecha);
    caja.appendChild(fila);
  });
}

// ---------------------------------------------------------------------------
// ANÁLISIS
// ---------------------------------------------------------------------------
function renderAnalisis() {
  $$("#periodo-tabs .filtro-btn").forEach((b) =>
    b.classList.toggle("activo", b.dataset.periodo === String(periodoAnalisis))
  );

  // 1. Ventas por período
  const grafico = $("#grafico-periodo");
  const totales = $("#totales-periodo");
  grafico.innerHTML = "";
  totales.innerHTML = "";

  if (periodoAnalisis === "meses") {
    const porMes = ventasPorMes(ventas, 6);
    grafico.appendChild(graficoBarras(porMes.map((m) => ({
      etiqueta: m.etiqueta, valor: m.ingresos, texto: formatearCOP(m.ingresos),
    }))));
    const totalIngresos = porMes.reduce((s, m) => s + m.ingresos, 0);
    const totalUnidades = porMes.reduce((s, m) => s + m.unidades, 0);
    totales.innerHTML =
      '<div><b>' + formatearCOP(totalIngresos) + '</b>Ingresos (6 meses)</div>' +
      '<div><b>' + totalUnidades + '</b>Unidades</div>';
  } else {
    const dias = Number(periodoAnalisis);
    const porDia = ventasPorDia(ventas, dias);
    grafico.appendChild(graficoBarras(porDia.map((d) => ({
      etiqueta: d.etiqueta, valor: d.ingresos, texto: formatearCOP(d.ingresos),
    }))));
    const totalIngresos = porDia.reduce((s, d) => s + d.ingresos, 0);
    const totalUnidades = porDia.reduce((s, d) => s + d.unidades, 0);
    totales.innerHTML =
      '<div><b>' + formatearCOP(totalIngresos) + '</b>Ingresos (' + dias + ' días)</div>' +
      '<div><b>' + totalUnidades + '</b>Unidades</div>';
  }

  // 2. Ingresos por categoría
  const porCategoria = ingresosPorCategoria(productos, ventas);
  const cajaCategorias = $("#grafico-categorias");
  cajaCategorias.innerHTML = "";
  cajaCategorias.appendChild(graficoTorta(porCategoria.map((c) => ({
    etiqueta: c.categoria, valor: c.ingresos, texto: formatearCOP(c.ingresos),
  }))));
  leyenda(porCategoria.map((c) => ({
    etiqueta: c.categoria, texto: formatearCOP(c.ingresos),
  })), $("#leyenda-categorias"));

  // 3. Ranking de productos
  const cajaRanking = $("#ranking-productos");
  cajaRanking.innerHTML = "";
  const ranking = productoMasVendido(ventas);
  if (!ranking || ranking.ranking.length === 0) {
    cajaRanking.textContent = "Aún no hay ventas para calcular el ranking.";
  } else {
    ranking.ranking.forEach((r, i) => {
      cajaRanking.appendChild(crearFilaRanking(
        i + 1,
        r.nombre,
        r.unidades + " unidad · " + formatearCOP(r.ingresos)
      ));
    });
  }

  // 4. Análisis financiero
  const fin = $("#analisis-financiero");
  fin.innerHTML = "";
  const kpis = calcularKPIs(productos, ventas);
  const filas = [
    ["Ingresos totales", formatearCOP(kpis.ingresos), ""],
    ["Unidades vendidas", String(kpis.unidades), ""],
    ["Número de ventas", String(kpis.numVentas), ""],
    ["Costo estimado de lo vendido", formatearCOP(kpis.ingresos - kpis.utilidad), ""],
    ["Utilidad estimada", formatearCOP(kpis.utilidad), kpis.utilidad >= 0 ? "utilidad-positiva" : "utilidad-negativa"],
  ];
  filas.forEach((f) => {
    const fila = document.createElement("div");
    fila.className = "fin-fila" + (f[2] ? " total" : "");
    fila.innerHTML = "<span>" + f[0] + "</span><span class='" + f[2] + "'>" + f[1] + "</span>";
    fin.appendChild(fila);
  });
}

function crearFilaRanking(pos, nombre, detalle) {
  const fila = document.createElement("div");
  fila.className = "ranking-fila";

  const posicion = document.createElement("span");
  posicion.className = "ranking-pos";
  posicion.textContent = pos;

  const info = document.createElement("div");
  info.className = "fila-info";
  const nom = document.createElement("div");
  nom.className = "fila-nombre";
  nom.textContent = nombre;
  const det = document.createElement("div");
  det.className = "fila-detalle";
  det.textContent = detalle;
  info.appendChild(nom);
  info.appendChild(det);

  fila.appendChild(posicion);
  fila.appendChild(info);
  return fila;
}

// ---------------------------------------------------------------------------
// ALERTAS DE STOCK
// ---------------------------------------------------------------------------
function productosEnAlerta() {
  const criticos = productosConStockBajo(productos);
  return criticos.agotados.concat(criticos.bajos);
}

function actualizarAlertas() {
  const alertas = productosEnAlerta();
  const contador = $("#contador-alertas");
  const banner = $("#banner-alertas");

  if (alertas.length > 0) {
    contador.textContent = alertas.length;
    contador.classList.remove("oculto");
    const agotados = alertas.filter((a) => a.stock <= 0).length;
    banner.innerHTML =
      "<b>🔔 " + alertas.length + " producto(s) requieren atención</b>" +
      (agotados > 0 ? agotados + " agotado(s). " : "") +
      "Toca para verlos.";
    banner.classList.remove("oculto");
  } else {
    contador.classList.add("oculto");
    banner.classList.add("oculto");
  }
}

function abrirAlertas() {
  const alertas = productosEnAlerta();
  const caja = $("#contenido-alertas");
  caja.innerHTML = "";
  if (alertas.length === 0) {
    caja.innerHTML = '<span style="color:#16a34a">✅ Todo el inventario está en buen nivel.</span>';
  } else {
    alertas.forEach((p) => {
      const fila = crearFilaProducto(p);
      fila.querySelector(".acciones-fila").remove();
      caja.appendChild(fila);
    });
  }
  $("#modal-alertas").classList.remove("oculto");
}

// Notificación del sistema (requiere permiso del usuario).
async function notificarStockBajo() {
  const alertas = productosEnAlerta();
  if (alertas.length === 0) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!$("#chk-notificaciones").checked) return;

  const agotados = alertas.filter((a) => a.stock <= 0);
  const titulo = "🔔 Stock bajo en Konta";
  const cuerpo = agotados.length > 0
    ? agotados.map((a) => "• " + a.nombre + " (agotado)").slice(0, 3).join("\n")
    : alertas.slice(0, 3).map((a) => "• " + a.nombre + " (" + a.stock + " unidad)").join("\n");
  try {
    new Notification(titulo, { body: cuerpo, icon: "icons/icon-192.png" });
  } catch (err) {
    // Algunos navegadores requieren service worker para notificaciones.
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(titulo, { body: cuerpo, icon: "icons/icon-192.png" });
      });
    }
  }
}

async function activarNotificaciones() {
  if (!("Notification" in window)) {
    toast("Tu navegador no soporta notificaciones.");
    return;
  }
  const permiso = await Notification.requestPermission();
  if (permiso === "granted") {
    $("#chk-notificaciones").checked = true;
    localStorage.setItem("minegocio_notif", "1");
    toast("Notificaciones activadas. Te avisaremos del stock bajo.");
    $("#btn-permitir-notif").classList.add("oculto");
  } else {
    toast("Permiso de notificaciones denegado.");
  }
}

function actualizarEstadoNotif() {
  const estado = $("#estado-notif");
  const btnPermitir = $("#btn-permitir-notif");
  if (!("Notification" in window)) {
    estado.textContent = "Tu navegador no soporta notificaciones.";
    btnPermitir.classList.add("oculto");
    return;
  }
  if (Notification.permission === "granted") {
    estado.textContent = "Notificaciones activadas.";
    btnPermitir.classList.add("oculto");
  } else if (Notification.permission === "denied") {
    estado.textContent = "Notificaciones bloqueadas. Habilítalas desde los ajustes del navegador.";
    btnPermitir.classList.add("oculto");
  } else {
    estado.textContent = "Toca el botón para permitir que la app te notifique.";
    btnPermitir.classList.remove("oculto");
  }
}

// ---------------------------------------------------------------------------
// CONFIGURACIÓN: exportar / importar / limpiar
// ---------------------------------------------------------------------------
async function exportarDatos() {
  const datos = { productos, ventas, exportado: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "minegocio-datos.json";
  a.click();
  URL.revokeObjectURL(url);
  toast("Datos exportados.");
}

function importarDatos() {
  $("#input-importar").click();
}

async function procesarImportacion(e) {
  const archivo = e.target.files[0];
  if (!archivo) return;
  try {
    const texto = await archivo.text();
    const datos = JSON.parse(texto);
    if (!Array.isArray(datos.productos) || !Array.isArray(datos.ventas)) {
      throw new Error("Formato no válido");
    }
    await limpiar("productos");
    await limpiar("ventas");
    for (const p of datos.productos) await guardar(p, "productos");
    for (const v of datos.ventas) await guardar(v, "ventas");
    toast("Datos importados correctamente.");
    await recargarTodo();
  } catch (err) {
    toast("El archivo no es válido.", "error");
  }
  e.target.value = "";
}

// ---------------------------------------------------------------------------
// EXCEL: exportar e importar (.xlsx)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
function hojaDesdeObjetos(nombre, datos, columnas) {
  const filas = datos.map((d) => {
    const fila = {};
    columnas.forEach(([clave, titulo]) => { fila[titulo] = d[clave]; });
    return fila;
  });
  const hoja = XLSX.utils.json_to_sheet(filas);
  hoja["!cols"] = columnas.map(() => ({ wch: 18 }));
  return hoja;
}

function exportarExcel() {
  if (typeof XLSX === "undefined") return toast("La librería de Excel no está disponible.", "error");

  const wb = XLSX.utils.book_new();

  wb.SheetNames.push("Productos");
  wb.Sheets["Productos"] = hojaDesdeObjetos("Productos", productos, [
    ["id", "id"], ["nombre", "nombre"], ["categoria", "categoria"],
    ["precio", "precio"], ["costo", "costo"], ["costo_unidad", "costo_unidad"], ["stock", "stock"],
    ["stock_minimo", "stock_minimo"], ["unidad", "unidad"],
    ["es_insumo", "es_insumo"], ["emoji", "emoji"],
  ]);

  wb.SheetNames.push("Ventas");
  wb.Sheets["Ventas"] = hojaDesdeObjetos("Ventas", ventas, [
    ["id", "id"], ["producto_id", "producto_id"], ["nombre_producto", "nombre_producto"],
    ["cantidad", "cantidad"], ["precio_unitario", "precio_unitario"],
    ["total", "total"], ["fecha", "fecha"],
  ]);

  wb.SheetNames.push("Categorías");
  wb.Sheets["Categorías"] = hojaDesdeObjetos("Categorías", categorias, [
    ["id", "id"], ["nombre", "nombre"],
  ]);

  const filasRecetas = recetas.map((r) => {
    const producto = productos.find((p) => p.id === r.producto_id);
    const insumo = productos.find((p) => p.id === r.insumo_id);
    return {
      id: r.id, producto_id: r.producto_id,
      producto_nombre: producto ? producto.nombre : "",
      insumo_id: r.insumo_id,
      insumo_nombre: insumo ? insumo.nombre : "",
      cantidad: r.cantidad,
    };
  });
  wb.SheetNames.push("Recetas");
  wb.Sheets["Recetas"] = hojaDesdeObjetos("Recetas", filasRecetas, [
    ["id", "id"], ["producto_id", "producto_id"], ["producto_nombre", "producto_nombre"],
    ["insumo_id", "insumo_id"], ["insumo_nombre", "insumo_nombre"], ["cantidad", "cantidad"],
  ]);

  XLSX.writeFile(wb, "minegocio-datos.xlsx");
  toast("Excel exportado correctamente.");
}

function importarExcel() {
  $("#input-importar-excel").click();
}

// Normaliza las claves de una fila: minúsculas y sin tildes.
function normalizarClaves(obj) {
  const salida = {};
  const mapa = { a: "a", e: "e", i: "i", o: "o", u: "u", n: "n" };
  for (const [k, v] of Object.entries(obj)) {
    const clave = k.toLowerCase().trim().split("").map((c) => mapa[c] || c).join("").replace(/[^a-z0-9_]/g, "");
    salida[clave] = v;
  }
  return salida;
}

function aBooleano(v) {
  if (typeof v === "boolean") return v;
  if (v === undefined || v === null) return false;
  const s = String(v).toLowerCase().trim();
  return ["1", "true", "si", "sí", "yes", "x"].includes(s);
}

function aNumero(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

async function procesarImportacionExcel(e) {
  const archivo = e.target.files[0];
  if (!archivo) return;

  try {
    const buffer = await archivo.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });

    const leerHoja = (nombre) => {
      const clave = Object.keys(wb.Sheets).find((s) => s.toLowerCase() === nombre.toLowerCase());
      return clave ? XLSX.utils.sheet_to_json(wb.Sheets[clave], { defval: "" }) : [];
    };

    const filasProductos = leerHoja("Productos").map(normalizarClaves);
    const filasVentas = leerHoja("Ventas").map(normalizarClaves);
    const filasCategorias = leerHoja("Categorías").map(normalizarClaves);
    const filasRecetas = leerHoja("Recetas").map(normalizarClaves);

    if (filasProductos.length === 0 && filasVentas.length === 0) {
      throw new Error("El archivo no tiene las hojas Productos o Ventas.");
    }

    // Construimos los registros nuevos.
    const productosNuevos = filasProductos.map((f) => {
      const r = {
        id: aNumero(f.id) || undefined,
        nombre: String(f.nombre || f.nombreproducto || "").trim(),
        categoria: String(f.categoria || "Otros").trim(),
        precio: aNumero(f.precio),
        costo: aNumero(f.costo),
        costo_unidad: f.costounidad !== undefined && f.costounidad !== "" && !isNaN(Number(f.costounidad)) ? Number(f.costounidad) : undefined,
        stock: aNumero(f.stock),
        stock_minimo: aNumero(f.stockminimo || f.stock_minimo),
        unidad: ["g", "ml", "unidad"].includes(String(f.unidad).trim()) ? String(f.unidad).trim() : "unidad",
        es_insumo: aBooleano(f.esinsumo || f.es_insumo),
        emoji: String(f.emoji || "📦").trim(),
      };
      if (!r.nombre) return null;
      return r;
    }).filter(Boolean);

    const categoriasNuevas = filasCategorias.map((f) => {
      const nombre = String(f.nombre || "").trim();
      if (!nombre) return null;
      return { id: aNumero(f.id) || undefined, nombre };
    }).filter(Boolean);

    const ventasNuevas = filasVentas.map((f) => ({
      id: aNumero(f.id) || undefined,
      producto_id: aNumero(f.productoid || f.producto_id),
      nombre_producto: String(f.nombreproducto || f.nombre_producto || "Producto").trim(),
      cantidad: aNumero(f.cantidad) || 1,
      precio_unitario: aNumero(f.preciounitario || f.precio_unitario),
      total: aNumero(f.total),
      fecha: String(f.fecha || new Date().toISOString().slice(0, 10)),
    })).filter((v) => v.producto_id > 0 || v.nombre_producto);

    const recetasNuevas = filasRecetas.map((f) => {
      let productoId = aNumero(f.productoid || f.producto_id);
      let insumoId = aNumero(f.insumoid || f.insumo_id);
      // Si no vienen IDs, intentamos resolver por nombre.
      if (!productoId) {
        const p = productosNuevos.find((x) => x.nombre.toLowerCase() === String(f.productonombre || "").toLowerCase());
        productoId = p && p.id ? p.id : 0;
      }
      if (!insumoId) {
        const i = productosNuevos.find((x) => x.nombre.toLowerCase() === String(f.insumonombre || "").toLowerCase());
        insumoId = i && i.id ? i.id : 0;
      }
      if (!productoId || !insumoId) return null;
      return { id: aNumero(f.id) || undefined, producto_id: productoId, insumo_id: insumoId, cantidad: aNumero(f.cantidad) || 1 };
    }).filter(Boolean);

    if (!window.confirm("Se reemplazarán TODOS los datos actuales por los del archivo (" + productosNuevos.length + " productos, " + ventasNuevas.length + " ventas, " + categoriasNuevas.length + " categorías, " + recetasNuevas.length + " recetas). ¿Continuar?")) return;

    // Guardamos todo (reemplazando).
    await limpiar("productos");
    await limpiar("ventas");
    await limpiar("categorias");
    await limpiar("recetas");

    if (categoriasNuevas.length === 0) {
      for (const nombre of ["Tortas", "Repostería", "Bebidas", "Otros"]) {
        await guardar({ nombre }, "categorias");
      }
    } else {
      for (const c of categoriasNuevas) await guardar(c, "categorias");
    }

    for (const p of productosNuevos) await guardar(p, "productos");
    for (const v of ventasNuevas) await guardar(v, "ventas");
    for (const r of recetasNuevas) await guardar(r, "recetas");

    toast("Excel importado correctamente.");
    await recargarTodo();
    renderProducir();
  } catch (err) {
    console.error(err);
    toast("No se pudo importar el archivo: " + (err.message || "formato no válido"), "error");
  }
  e.target.value = "";
}

async function borrarTodo() {
  if (!window.confirm("¿Borrar TODOS los productos y ventas? Esta acción no se puede deshacer.")) return;
  await limpiar("productos");
  await limpiar("ventas");
  await recargarTodo();
  toast("Todos los datos fueron borrados.");
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function configurarEventos() {
  // Navegación (la vista "admin" pasa por entrarAdmin para limpiar el modo
  // revisión y volver al panel).
  $$(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.vista === "admin") {
        entrarAdmin();
      } else {
        cambiarVista(b.dataset.vista);
      }
    })
  );

  // Fecha de hoy
  $("#fecha-hoy").textContent = new Date().toLocaleDateString("es-CO", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // Ventas
  $("#form-venta").addEventListener("submit", registrarVenta);
  $$("#filtros-ventas .filtro-btn").forEach((b) =>
    b.addEventListener("click", () => {
      filtroVentas = Number(b.dataset.dias);
      renderVentas();
    })
  );

  // Productos
  $("#btn-nuevo-producto").addEventListener("click", () => abrirModalProducto(null));
  $("#form-producto").addEventListener("submit", guardarProducto);
  $("#btn-cancelar-producto").addEventListener("click", cerrarModalProducto);
  $("#producto-es-insumo").addEventListener("change", () => {
    actualizarCampoPrecioInsumo();
    actualizarCampoCostoInsumo();
  });
  $("#producto-unidad").addEventListener("change", () => {
    actualizarCampoPrecioInsumo();
    actualizarCampoCostoInsumo();
  });
  $("#producto-stock").addEventListener("input", () => {
    actualizarCampoCostoInsumo();
  });
  $("#modal-producto").addEventListener("click", (e) => {
    if (e.target === $("#modal-producto")) cerrarModalProducto();
  });
  $("#buscador-productos").addEventListener("input", (e) => {
    terminoBusqueda = e.target.value.trim();
    renderProductos();
  });

  // Categorías
  $("#btn-categorias").addEventListener("click", abrirModalCategorias);
  $("#form-categoria").addEventListener("submit", guardarCategoria);
  $("#btn-cerrar-categorias").addEventListener("click", cerrarModalCategorias);
  $("#modal-categorias").addEventListener("click", (e) => {
    if (e.target === $("#modal-categorias")) cerrarModalCategorias();
  });

  // Recetas
  $("#form-receta").addEventListener("submit", guardarReceta);
  $("#btn-cancelar-receta").addEventListener("click", cerrarModalReceta);
  $("#modal-receta").addEventListener("click", (e) => {
    if (e.target === $("#modal-receta")) cerrarModalReceta();
  });

  // Producir
  $("#producir-producto").addEventListener("change", calcularNecesidades);
  $("#btn-registrar-produccion").addEventListener("click", registrarProduccion);

  // Análisis
  $$("#periodo-tabs .filtro-btn").forEach((b) =>
    b.addEventListener("click", () => {
      periodoAnalisis = b.dataset.periodo;
      renderAnalisis();
    })
  );

  // Alertas
  $("#btn-alertas").addEventListener("click", abrirAlertas);
  $("#banner-alertas").addEventListener("click", abrirAlertas);
  $("#btn-cerrar-alertas").addEventListener("click", () =>
    $("#modal-alertas").classList.add("oculto")
  );
  $("#modal-alertas").addEventListener("click", (e) => {
    if (e.target === $("#modal-alertas")) $("#modal-alertas").classList.add("oculto");
  });

  // Ayuda y autorización de uso de datos (usuarios de empresa)
  $("#btn-ayuda").addEventListener("click", abrirAyuda);
  $("#btn-cerrar-ayuda").addEventListener("click", cerrarAyuda);
  $("#btn-guardar-autorizacion").addEventListener("click", guardarAutorizacion);
  $("#modal-ayuda").addEventListener("click", (e) => {
    if (e.target === $("#modal-ayuda")) cerrarAyuda();
  });

  // Config
  $("#btn-exportar").addEventListener("click", exportarDatos);
  $("#btn-importar").addEventListener("click", importarDatos);
  $("#input-importar").addEventListener("change", procesarImportacion);
  $("#btn-exportar-excel").addEventListener("click", exportarExcel);
  $("#btn-importar-excel").addEventListener("click", importarExcel);
  $("#input-importar-excel").addEventListener("change", procesarImportacionExcel);
  $("#btn-borrar-todo").addEventListener("click", borrarTodo);
  $("#btn-permitir-notif").addEventListener("click", activarNotificaciones);
  $("#chk-notificaciones").addEventListener("change", (e) => {
    if (e.target.checked) {
      if (Notification.permission !== "granted") {
        activarNotificaciones();
      }
      localStorage.setItem("minegocio_notif", "1");
    } else {
      localStorage.setItem("minegocio_notif", "0");
    }
  });

  // Cerrar modales con tecla Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      cerrarModalProducto();
      cerrarModalCategorias();
      cerrarModalReceta();
      $("#modal-alertas").classList.add("oculto");
      cerrarAyuda();
    }
  });

  // Autenticación
  $("#form-login").addEventListener("submit", manejarLogin);
  $("#form-cambiar").addEventListener("submit", manejarCambiar);
  $("#form-recuperar").addEventListener("submit", manejarRecuperar);
  $("#form-nueva").addEventListener("submit", manejarNueva);
  $("#btn-ir-login-2").addEventListener("click", () => cambiarFormAuth("login"));
  $("#btn-ir-recuperar").addEventListener("click", () => cambiarFormAuth("recuperar"));
  $("#btn-nueva-cancelar").addEventListener("click", () => cambiarFormAuth("recuperar"));
  $("#btn-cerrar-sesion").addEventListener("click", manejarCerrarSesion);
  $("#btn-cerrar-sesion-top").addEventListener("click", manejarCerrarSesion);
  $("#btn-volver-admin").addEventListener("click", entrarAdmin);

  // Administración (solo admin global)
  $("#form-crear-empresa").addEventListener("submit", manejarCrearEmpresa);
  $("#form-crear-usuario").addEventListener("submit", manejarCrearUsuario);
  $("#btn-restablecer-datos").addEventListener("click", restablecerDispositivo);
  // Mostrar / ocultar contraseña (botón ojo dentro de los campos).
  document.addEventListener("click", (e) => {
    const ojo = e.target.closest(".btn-ojo");
    if (!ojo) return;
    const input = document.getElementById(ojo.dataset.objetivo);
    if (!input) return;
    if (input.type === "password") {
      input.type = "text";
      ojo.textContent = "🙈";
    } else {
      input.type = "password";
      ojo.textContent = "👁️";
    }
    input.focus();
  });
}

// ---------------------------------------------------------------------------
// Service worker (PWA)
// ---------------------------------------------------------------------------
function registrarServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then(() => {
        // Actualización automática: cuando una versión nueva del service worker
        // toma el control (solo si ya había una instalada), recargamos una vez
        // para cargar la app actualizada.
        const yaControlaba = !!navigator.serviceWorker.controller;
        if (!yaControlaba) return;
        let recargando = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (recargando) return;
          recargando = true;
          window.location.reload();
        });
      }).catch((err) => {
        console.warn("No se pudo registrar el service worker:", err);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------------------
async function inicializar() {
  $("#fecha-hoy").textContent = new Date().toLocaleDateString("es-CO", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  configurarEventos();
  registrarServiceWorker();

  // Cada cambio de datos (guardar/eliminar) programa una sincronización.
  setAlCambiarDatos(() => {
    if (correoSesion()) programarSync();
  });

  // Migración única desde la versión anterior (una sola BD con empresa_id).
  try {
    await migrarDesdeAntigua();
  } catch (err) {
    console.warn("No se pudo migrar la base de datos anterior:", err);
  }
  // El administrador global se crea la primera vez.
  await sembrarAdminInicial();
  await llenarLoginEmpresas();

  // Bloqueamos la app hasta que haya una sesión activa.
  const sesion = await obtenerSesion();
  if (sesion) {
    usuarioActual = sesion;
    if (esAdmin()) {
      // Si el admin estaba revisando una empresa, reanuda esa revisión.
      const revisionId = localStorage.getItem(CLAVE_REVISION);
      if (revisionId) {
        await entrarRevision(revisionId);
      } else {
        await entrarAdmin();
      }
    } else if (usuarioActual.debe_cambiar_clave) {
      // No se puede reanudar una sesión a medias: forzamos login.
      cerrarSesion();
      usuarioActual = null;
      mostrarPantallaAuth(true);
      cambiarFormAuth("login");
    } else {
      await entrarApp();
    }
  } else {
    mostrarPantallaAuth(true);
    cambiarFormAuth("login");
  }

  // Sincronización en segundo plano al abrir (si hay sesión y conexión).
  haySesionNube().then((hay) => actualizarIndicadorSync(hay ? "online" : "offline"));
  programarSync();
}

inicializar();