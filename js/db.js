/*
 * db.js - Capa de datos de Konta (multi-empresa con bases separadas).
 *
 * Hay DOS tipos de base de datos IndexedDB:
 *   - konta_cuentas:  BD GLOBAL de cuentas. Stores: usuarios y empresas.
 *   - konta_emp_<id>: BD PROPIA DE CADA EMPRESA. Stores: productos, ventas,
 *                     categorias y recetas. Cada empresa tiene la suya, así
 *                     los datos están totalmente aislados.
 *
 * Las funciones leer/guardar/eliminar/limpiar/transaccion eligen la BD según
 * el nombre del store ("usuarios"/"empresas" -> global; datos -> empresa activa).
 */

const DB_CUENTAS_NOMBRE = "konta_cuentas";
const DB_CUENTAS_VERSION = 1;
const PREFIJO_BD_EMPRESA = "konta_emp_";
const CLAVE_EMPRESA_ACTIVA = "konta_empresa";
const CLAVE_TUMBAS = "konta_sync_tumbas";  // borrados pendientes de sincronizar

const STORES_GLOBALES = ["usuarios", "empresas"];
const STORES_EMPRESA = ["productos", "ventas", "categorias", "recetas"];

// Callback opcional para avisar cuando cambian los datos (lo usa la
// sincronización con la nube para volver a subir cambios).
let alCambiarDatos = null;

function setAlCambiarDatos(fn) {
  alCambiarDatos = fn;
}

function notificarCambio() {
  if (typeof alCambiarDatos === "function") {
    try { alCambiarDatos(); } catch (e) { /* ignorar */ }
  }
}

// ---------------------------------------------------------------------------
// Tumbas de borrado (para sincronizar eliminaciones a la nube)
// ---------------------------------------------------------------------------
function leerTumbas() {
  try { return JSON.parse(localStorage.getItem(CLAVE_TUMBAS) || "[]"); }
  catch { return []; }
}

function guardarTumbas(lista) {
  try { localStorage.setItem(CLAVE_TUMBAS, JSON.stringify(lista)); } catch (e) { /* ignorar */ }
}

function limpiarTumba(tabla, empresaId, id) {
  const rest = leerTumbas().filter((t) =>
    !(t.tabla === tabla && String(t.empresa_id) === String(empresaId) && String(t.id) === String(id))
  );
  guardarTumbas(rest);
}

function agregarTumba(tabla, empresaId, id, updatedAt) {
  const lista = leerTumbas().filter((t) =>
    !(t.tabla === tabla && String(t.empresa_id) === String(empresaId) && String(t.id) === String(id))
  );
  lista.push({ tabla, empresa_id: empresaId, id, updated_at: updatedAt || new Date().toISOString() });
  guardarTumbas(lista);
}

// Conexiones IndexedDB en caché por nombre de base: evita abrir una conexión
// nueva en cada operación (se colgaba la app con varias empresas).
const conexiones = new Map();

function conexionCacheada(nombre) {
  return conexiones.get(nombre) || null;
}

function guardarConexion(nombre, bd) {
  conexiones.set(nombre, bd);
  bd.onclose = () => { if (conexiones.get(nombre) === bd) conexiones.delete(nombre); };
}

function cerrarConexion(nombre) {
  const bd = conexiones.get(nombre);
  if (bd) {
    conexiones.delete(nombre);
    try { bd.close(); } catch (e) { /* ignorar */ }
  }
}

// ---------------------------------------------------------------------------
// Utilidades para abrir cada base de datos
// ---------------------------------------------------------------------------

function abrirBDGlobal() {
  const enCache = conexionCacheada(DB_CUENTAS_NOMBRE);
  if (enCache) return Promise.resolve(enCache);
  return new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(DB_CUENTAS_NOMBRE, DB_CUENTAS_VERSION);
    peticion.onupgradeneeded = (e) => {
      const bd = e.target.result;
      if (!bd.objectStoreNames.contains("usuarios")) {
        const store = bd.createObjectStore("usuarios", { keyPath: "email" });
      }
      if (!bd.objectStoreNames.contains("empresas")) {
        const store = bd.createObjectStore("empresas", { keyPath: "id", autoIncrement: true });
        store.createIndex("nombre", "nombre", { unique: false });
      }
    };
    peticion.onsuccess = () => {
      const bd = peticion.result;
      guardarConexion(DB_CUENTAS_NOMBRE, bd);
      resolver(bd);
    };
    peticion.onerror = () => rechazar(peticion.error);
  });
}

// Abre la base de datos propia de una empresa (la crea si no existe).
function abrirBDEmpresa(empresaId) {
  const nombre = PREFIJO_BD_EMPRESA + empresaId;
  const enCache = conexionCacheada(nombre);
  if (enCache) return Promise.resolve(enCache);
  return new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(nombre, 1);
    peticion.onupgradeneeded = (e) => {
      const bd = e.target.result;
      if (!bd.objectStoreNames.contains("productos")) {
        const store = bd.createObjectStore("productos", { keyPath: "id", autoIncrement: true });
        store.createIndex("nombre", "nombre", { unique: false });
      }
      if (!bd.objectStoreNames.contains("ventas")) {
        const store = bd.createObjectStore("ventas", { keyPath: "id", autoIncrement: true });
        store.createIndex("fecha", "fecha", { unique: false });
        store.createIndex("producto_id", "producto_id", { unique: false });
      }
      if (!bd.objectStoreNames.contains("categorias")) {
        bd.createObjectStore("categorias", { keyPath: "id", autoIncrement: true });
      }
      if (!bd.objectStoreNames.contains("recetas")) {
        const store = bd.createObjectStore("recetas", { keyPath: "id", autoIncrement: true });
        store.createIndex("producto_id", "producto_id", { unique: false });
      }
    };
    peticion.onsuccess = () => {
      const bd = peticion.result;
      guardarConexion(nombre, bd);
      resolver(bd);
    };
    peticion.onerror = () => rechazar(peticion.error);
  });
}

// Devuelve la BD correcta para un store dado.
function abrirBD(nombreStore) {
  if (STORES_GLOBALES.includes(nombreStore)) return abrirBDGlobal();
  return abrirBDEmpresa(empresaActivaId() || 0);
}

// Id de la empresa activa (guardada en localStorage al entrar).
function empresaActivaId() {
  return Number(localStorage.getItem(CLAVE_EMPRESA_ACTIVA)) || null;
}

// ---------------------------------------------------------------------------
// Operaciones genéricas (enrutadas por store)
// ---------------------------------------------------------------------------

// Ejecuta una operacion de lectura/escritura dentro de una transaccion.
// Si la operación es un request (put/add/delete/get), resuelve con su resultado
// (para put/add con autoIncrement, la clave generada).
async function transaccion(nombreStore, modo, operacion) {
  const bd = await abrirBD(nombreStore);
  return new Promise((resolver, rechazar) => {
    const tx = bd.transaction(nombreStore, modo);
    const store = tx.objectStore(nombreStore);
    const resultado = operacion(store);

    tx.oncomplete = () => {
      if (resultado && typeof resultado.result !== "undefined") resolver(resultado.result);
      else resolver(resultado);
    };
    tx.onerror = () => rechazar(tx.error);
    tx.onabort = () => rechazar(tx.error);
  });
}

// Lee un valor por su clave.
function leer(clave, nombreStore) {
  return new Promise((resolver, rechazar) => {
    abrirBD(nombreStore).then((bd) => {
      const tx = bd.transaction(nombreStore, "readonly");
      const peticion = tx.objectStore(nombreStore).get(clave);
      peticion.onsuccess = () => resolver(peticion.result);
      peticion.onerror = () => rechazar(peticion.error);
    });
  });
}

// Lee todos los registros de una tienda (opcionalmente filtrados por indice).
function leerTodos(nombreStore, indice) {
  return new Promise((resolver, rechazar) => {
    abrirBD(nombreStore).then((bd) => {
      const tx = bd.transaction(nombreStore, "readonly");
      const store = tx.objectStore(nombreStore);
      let peticion;
      if (indice) {
        peticion = store.index(indice).getAll();
      } else {
        peticion = store.getAll();
      }
      peticion.onsuccess = () => resolver(peticion.result || []);
      peticion.onerror = () => rechazar(peticion.error);
    });
  });
}

// Guarda un registro (si no tiene id lo crea, si lo tiene lo actualiza).
// Siempre sella la fecha de última modificación para la sincronización.
function guardar(registro, nombreStore) {
  registro.updated_at = new Date().toISOString();
  notificarCambio();
  return transaccion(nombreStore, "readwrite", (store) => store.put(registro));
}

// Elimina un registro por su clave y deja una "tumba" para sincronizar el
// borrado a la nube.
function eliminar(clave, nombreStore) {
  const empresaId = STORES_GLOBALES.includes(nombreStore) ? null : empresaActivaId();
  agregarTumba(nombreStore, empresaId, clave, new Date().toISOString());
  notificarCambio();
  return transaccion(nombreStore, "readwrite", (store) => store.delete(clave));
}

// Elimina todos los registros de una tienda.
function limpiar(nombreStore) {
  return transaccion(nombreStore, "readwrite", (store) => store.clear());
}

// ---------------------------------------------------------------------------
// Operaciones de sincronización (usadas por sync.js)
// ---------------------------------------------------------------------------

// Aplica un registro traído de la nube SIN sobrescribir su updated_at y SIN
// disparar la sincronización (evita bucles). Si el store es global usa la BD
// de cuentas; si es de empresa usa la BD de la empresa indicada.
function aplicarRegistro(nombreStore, registro, empresaId) {
  const bd = STORES_GLOBALES.includes(nombreStore)
    ? abrirBDGlobal()
    : abrirBDEmpresa(empresaId);
  return bd.then((con) => new Promise((resolver, rechazar) => {
    const tx = con.transaction(nombreStore, "readwrite");
    const req = tx.objectStore(nombreStore).put(registro);
    tx.oncomplete = () => resolver(req.result);
    tx.onerror = () => rechazar(tx.error);
    tx.onabort = () => rechazar(tx.error);
  }));
}

// Elimina un registro local aplicando un borrado que vino de la nube.
function aplicarEliminacion(nombreStore, clave, empresaId) {
  const bd = STORES_GLOBALES.includes(nombreStore)
    ? abrirBDGlobal()
    : abrirBDEmpresa(empresaId);
  return bd.then((con) => new Promise((resolver, rechazar) => {
    const tx = con.transaction(nombreStore, "readwrite");
    tx.objectStore(nombreStore).delete(clave);
    tx.oncomplete = () => resolver();
    tx.onerror = () => rechazar(tx.error);
    tx.onabort = () => rechazar(tx.error);
  }));
}

// Lee todos los registros de un store dentro de la BD de una empresa concreta
// (para sincronizar varias empresas sin cambiar la empresa activa).
function leerTodosDeEmpresa(empresaId, nombreStore) {
  return abrirBDEmpresa(empresaId).then((bd) => new Promise((resolver, rechazar) => {
    const tx = bd.transaction(nombreStore, "readonly");
    const peticion = tx.objectStore(nombreStore).getAll();
    peticion.onsuccess = () => resolver(peticion.result || []);
    peticion.onerror = () => rechazar(peticion.error);
  }));
}

// ---------------------------------------------------------------------------
// Empresas (gestionadas por el administrador global)
// ---------------------------------------------------------------------------

// Crea una empresa nueva: la registra en la BD global y crea su BD de datos.
async function crearEmpresa(nombre) {
  const nombreLimpio = String(nombre || "").trim();
  if (!nombreLimpio) throw new Error("El nombre de la empresa es obligatorio.");

  const empresa = {
    nombre: nombreLimpio,
    creado: Date.now(),
  };
  const id = await guardar(empresa, "empresas");
  empresa.id = id;

  // Creamos la BD propia de la empresa y sembramos datos de ejemplo.
  await abrirBDEmpresa(id);
  await sembrarDatosSiVacio(id);

  return empresa;
}

// Devuelve todas las empresas (lista global).
async function listarEmpresas() {
  const todas = await leerTodos("empresas");
  return todas.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// Elimina una empresa y su base de datos completa.
async function eliminarEmpresa(id) {
  await eliminar(id, "empresas");
  cerrarConexion(PREFIJO_BD_EMPRESA + id);
  await new Promise((resolver) => {
    const peticion = indexedDB.deleteDatabase(PREFIJO_BD_EMPRESA + id);
    peticion.onsuccess = peticion.onerror = peticion.onblocked = () => resolver();
  });
}

// ---------------------------------------------------------------------------
// Datos de ejemplo para la primera vez (por empresa)
// ---------------------------------------------------------------------------
const PRODUCTOS_EJEMPLO = [
  { nombre: "Torta de Chocolate", categoria: "Tortas", precio: 45000, costo: 11150, stock: 10, stock_minimo: 5, emoji: "🍫", unidad: "unidad" },
  { nombre: "Torta Red Velvet", categoria: "Tortas", precio: 50000, costo: 7350, stock: 3, stock_minimo: 5, emoji: "🍰", unidad: "unidad" },
  { nombre: "Torta Tres Leches", categoria: "Tortas", precio: 42000, costo: 6600, stock: 12, stock_minimo: 4, emoji: "🥛", unidad: "unidad" },
  { nombre: "Cupcakes (Caja x6)", categoria: "Repostería", precio: 30000, costo: 4525, stock: 25, stock_minimo: 8, emoji: "🧁", unidad: "unidad" },
  { nombre: "Galletas Decoradas", categoria: "Repostería", precio: 25000, costo: 5900, stock: 2, stock_minimo: 6, emoji: "🍪", unidad: "unidad" },
  { nombre: "Cajita de Macarons", categoria: "Repostería", precio: 35000, costo: 2675, stock: 0, stock_minimo: 3, emoji: "🍬", unidad: "unidad" },
];

const CATEGORIAS_EJEMPLO = ["Tortas", "Repostería", "Bebidas", "Otros"];

const INSUMOS_EJEMPLO = [
  { nombre: "Harina", categoria: "Insumos", precio: 5000, costo: 4500, stock: 1000, stock_minimo: 200, emoji: "🍞", es_insumo: true, unidad: "g" },
  { nombre: "Azúcar", categoria: "Insumos", precio: 4000, costo: 4000, stock: 1000, stock_minimo: 200, emoji: "🍬", es_insumo: true, unidad: "g" },
  { nombre: "Mantequilla", categoria: "Insumos", precio: 6000, costo: 9000, stock: 500, stock_minimo: 100, emoji: "🧈", es_insumo: true, unidad: "g" },
  { nombre: "Huevos", categoria: "Insumos", precio: 3000, costo: 7200, stock: 12, stock_minimo: 12, emoji: "🥚", es_insumo: true, unidad: "unidad" },
  { nombre: "Chocolate", categoria: "Insumos", precio: 8000, costo: 14000, stock: 500, stock_minimo: 100, emoji: "🍫", es_insumo: true, unidad: "g" },
  { nombre: "Crema de leche", categoria: "Insumos", precio: 7000, costo: 9000, stock: 1000, stock_minimo: 200, emoji: "🥛", es_insumo: true, unidad: "ml" },
  { nombre: "Leche Condensada", categoria: "Insumos", precio: 6000, costo: 10000, stock: 1000, stock_minimo: 200, emoji: "🥛", es_insumo: true, unidad: "ml" },
];

const RECETAS_EJEMPLO = {
  "Torta de Chocolate": [["Harina", 300], ["Azúcar", 150], ["Huevos", 3], ["Mantequilla", 100], ["Chocolate", 200]],
  "Torta Red Velvet": [["Harina", 300], ["Azúcar", 150], ["Huevos", 3], ["Mantequilla", 100], ["Crema de leche", 200]],
  "Torta Tres Leches": [["Harina", 300], ["Azúcar", 150], ["Huevos", 3], ["Leche Condensada", 150], ["Crema de leche", 150]],
  "Cupcakes (Caja x6)": [["Harina", 250], ["Azúcar", 100], ["Huevos", 2], ["Mantequilla", 100]],
  "Galletas Decoradas": [["Harina", 200], ["Azúcar", 100], ["Mantequilla", 100], ["Chocolate", 100]],
  "Cajita de Macarons": [["Harina", 150], ["Azúcar", 200], ["Huevos", 2]],
};

// Genera ventas de los últimos 15 días para que las gráficas tengan datos.
function generarVentasEjemplo(productosReales) {
  const ventas = [];
  const hoy = new Date();
  const nombres = ["Torta de Chocolate", "Torta Red Velvet", "Cupcakes (Caja x6)", "Galletas Decoradas", "Cajita de Macarons"];
  const precios = { "Torta de Chocolate": 45000, "Torta Red Velvet": 50000, "Cupcakes (Caja x6)": 30000, "Galletas Decoradas": 25000, "Cajita de Macarons": 35000 };

  const idPorNombre = {};
  (productosReales || []).forEach((p) => { idPorNombre[p.nombre] = p.id; });

  let id = 1;
  for (let dia = 14; dia >= 0; dia--) {
    const fecha = new Date(hoy);
    fecha.setDate(fecha.getDate() - dia);
    const fechaStr = fecha.toISOString().slice(0, 10);

    const numVentas = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < numVentas; i++) {
      const nombre = nombres[Math.floor(Math.random() * nombres.length)];
      const cantidad = 1 + Math.floor(Math.random() * 3);
      const producto_id = idPorNombre[nombre];
      ventas.push({
        id: id++,
        producto_id: producto_id,
        nombre_producto: nombre,
        cantidad: cantidad,
        precio_unitario: precios[nombre],
        total: precios[nombre] * cantidad,
        fecha: fechaStr,
      });
    }
  }
  return ventas;
}

// Si la empresa no tiene datos, inserta datos de ejemplo.
async function sembrarDatosSiVacio(empresaId) {
  const bd = await abrirBDEmpresa(empresaId);
  const anterior = localStorage.getItem(CLAVE_EMPRESA_ACTIVA);
  localStorage.setItem(CLAVE_EMPRESA_ACTIVA, String(empresaId));
  try {
    const categorias = await leerTodos("categorias");
    if (categorias.length === 0) {
      for (const nombre of CATEGORIAS_EJEMPLO) {
        await guardar({ nombre }, "categorias");
      }
    }

    const productos = await leerTodos("productos");
    if (productos.length > 0) {
      await sembrarInsumosYRecetas();
      return;
    }

    for (const p of PRODUCTOS_EJEMPLO) {
      await guardar(p, "productos");
    }

    const ventas = await leerTodos("ventas");
    if (ventas.length === 0) {
      const productosRecien = await leerTodos("productos");
      for (const v of generarVentasEjemplo(productosRecien)) {
        await guardar(v, "ventas");
      }
    }

    const productosRecien = await leerTodos("productos");
    await sembrarInsumosYRecetas();
  } finally {
    if (anterior) localStorage.setItem(CLAVE_EMPRESA_ACTIVA, anterior);
    else localStorage.removeItem(CLAVE_EMPRESA_ACTIVA);
  }
}

// Inserta los insumos de ejemplo y las recetas que unen productos con insumos.
async function sembrarInsumosYRecetas() {
  const recetas = await leerTodos("recetas");
  if (recetas.length > 0) return;

  const productos = await leerTodos("productos");
  const insumosExistentes = productos.filter((p) => p.es_insumo);
  if (insumosExistentes.length > 0) return;

  for (const insumo of INSUMOS_EJEMPLO) {
    await guardar(insumo, "productos");
  }

  const todos = await leerTodos("productos");
  const idDeNombre = {};
  for (const p of todos) idDeNombre[p.nombre] = p.id;

  for (const [productoNombre, ingredientes] of Object.entries(RECETAS_EJEMPLO)) {
    const productoId = idDeNombre[productoNombre];
    if (!productoId) continue;
    for (const [insumoNombre, cantidad] of ingredientes) {
      const insumoId = idDeNombre[insumoNombre];
      if (!insumoId) continue;
      await guardar({ producto_id: productoId, insumo_id: insumoId, cantidad }, "recetas");
    }
  }
}

// ---------------------------------------------------------------------------
// Migración desde la versión anterior (minegocio_db con empresa_id)
// ---------------------------------------------------------------------------
// En la versión anterior todos los datos vivían en una sola BD (minegocio_db)
// y se aislaban con el campo empresa_id. Ahora cada empresa tiene su propia BD,
// así que migramos: empresas -> konta_cuentas.empresas, datos -> konta_emp_<id>,
// usuarios -> konta_cuentas.usuarios (asignándolos a su empresa).
const CLAVE_MIGRADO = "konta_migrado_v6";

async function migrarDesdeAntigua() {
  if (localStorage.getItem(CLAVE_MIGRADO) === "1") return;

  const existeAntigua = await new Promise((resolver) => {
    const req = indexedDB.open("minegocio_db", 5);
    req.onsuccess = () => {
      const bd = req.result;
      const ok = bd.objectStoreNames.contains("empresas") || bd.objectStoreNames.contains("productos");
      if (!ok) { bd.close(); resolver(false); return; }

      const leerTodo = (store) => new Promise((res) => {
        const tx = bd.transaction(store, "readonly");
        tx.objectStore(store).getAll().onsuccess = (e) => res(e.target.result);
        tx.objectStore(store).getAll().onerror = () => res([]);
      });

      (async () => {
        const [empresasViejas, usuariosViejos, productos, ventas, categorias, recetas] = await Promise.all([
          leerTodo("empresas"),
          leerTodo("usuarios"),
          leerTodo("productos"),
          leerTodo("ventas"),
          leerTodo("categorias"),
          leerTodo("recetas"),
        ]);
        bd.close();

        // 1) Empresas: las recreamos en la BD global y copiamos sus datos.
        //    Los registros legacy (sin empresa_id) van a la primera empresa.
        const empresas = empresasViejas && empresasViejas.length ? empresasViejas : [null];
        let primeraEmpresaId = null;

        for (const vieja of empresas) {
          const nombre = vieja ? vieja.nombre : "DolceVita";
          const nueva = { nombre, creado: Date.now() };
          await guardar(nueva, "empresas");
          const nuevaId = nueva.id;
          if (!primeraEmpresaId) primeraEmpresaId = nuevaId;

          // Abrimos la BD nueva de la empresa y la ponemos como activa para
          // que las operaciones de escritura se enruten a su base de datos.
          await abrirBDEmpresa(nuevaId);
          const previa = localStorage.getItem(CLAVE_EMPRESA_ACTIVA);
          localStorage.setItem(CLAVE_EMPRESA_ACTIVA, String(nuevaId));

          // Asignamos los registros que pertenecen a esta empresa.
          const esDe = (reg) => reg.empresa_id === (vieja && vieja.id) ||
            (vieja === null && reg.empresa_id === undefined);

          for (const cat of categorias.filter(esDe)) {
            const c = { nombre: cat.nombre };
            await guardar(c, "categorias");
          }
          const idProducto = {};
          for (const p of productos.filter(esDe)) {
            const copia = { ...p };
            delete copia.empresa_id;
            delete copia.id;
            await guardar(copia, "productos");
            idProducto[p.id] = copia.id;
          }
          for (const v of ventas.filter(esDe)) {
            const copia = { ...v };
            delete copia.empresa_id;
            delete copia.id;
            if (idProducto[v.producto_id]) copia.producto_id = idProducto[v.producto_id];
            await guardar(copia, "ventas");
          }
          for (const r of recetas.filter(esDe)) {
            const copia = { ...r };
            delete copia.empresa_id;
            delete copia.id;
            if (idProducto[r.producto_id]) copia.producto_id = idProducto[r.producto_id];
            if (idProducto[r.insumo_id]) copia.insumo_id = idProducto[r.insumo_id];
            await guardar(copia, "recetas");
          }

          // Restauramos la empresa activa anterior.
          if (previa) localStorage.setItem(CLAVE_EMPRESA_ACTIVA, previa);
          else localStorage.removeItem(CLAVE_EMPRESA_ACTIVA);
        }

        // 2) Usuarios: los recreamos en la BD global asignándoles su empresa
        //    (por propietario, o la primera empresa si no se sabe).
        for (const u of usuariosViejos || []) {
          const copia = { ...u };
          // El propietario es el correo que creó la empresa (empresas antiguas).
          const vieja = (empresasViejas || []).find((e) => e.propietario === u.email);
          const empresaId = vieja ? (await listarEmpresas()).find((e) => e.nombre === vieja.nombre)?.id : null;
          copia.empresa_id = empresaId || primeraEmpresaId || null;
          copia.rol = copia.rol || "usuario";
          copia.debe_cambiar_clave = copia.debe_cambiar_clave || false;
          await guardar(copia, "usuarios");
        }
      })().then(() => {
        // Cerramos/eliminamos la BD antigua.
        try { indexedDB.deleteDatabase("minegocio_db"); } catch { /* noop */ }
        localStorage.setItem(CLAVE_MIGRADO, "1");
        resolver(true);
      }).catch(() => resolver(false));
    };
    req.onerror = req.onblocked = () => resolver(false);
  });

  return existeAntigua;
}

export {
  abrirBD, abrirBDGlobal, abrirBDEmpresa, transaccion, leer, leerTodos,
  guardar, eliminar, limpiar, sembrarDatosSiVacio, crearEmpresa,
  listarEmpresas, eliminarEmpresa, migrarDesdeAntigua,
  aplicarRegistro, aplicarEliminacion, leerTodosDeEmpresa,
  setAlCambiarDatos, leerTumbas, guardarTumbas, limpiarTumba,
  empresaActivaId,
};