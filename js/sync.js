/*
 * sync.js - Sincronización con Supabase (nube) para Konta.
 *
 * La app sigue funcionando offline (IndexedDB es la fuente de verdad local).
 * Cuando hay conexión:
 *   1. vincularCuenta()  - vincula la cuenta local con Supabase Auth
 *                          (inicia sesión o crea la cuenta por primera vez).
 *   2. reclamarFilaUsuario() - asegura que la fila del usuario en la tabla
 *                          "usuarios" tenga su auth_uid (para la seguridad RLS).
 *   3. sincronizarTodo() - mezcla local <-> nube en ambas direcciones con
 *                          resolución "gana el último que guardó" (por
 *                          updated_at). Los borrados viajan como tumbas.
 *
 * Tablas: empresas, usuarios (globales) y productos, ventas, categorias,
 * recetas (con clave compuesta empresa_id + id).
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";
import {
  leer, leerTodos, listarEmpresas, aplicarRegistro, aplicarEliminacion,
  leerTodosDeEmpresa, leerTumbas, limpiarTumba,
} from "./db.js";

const TABLAS = {
  empresas:   { global: true,  onConflict: "id", clave: (r) => String(r.id) },
  usuarios:   { global: true,  onConflict: "email", clave: (r) => r.email },
  productos:  { global: false, onConflict: "empresa_id,id", clave: (r) => r.empresa_id + ":" + r.id },
  ventas:     { global: false, onConflict: "empresa_id,id", clave: (r) => r.empresa_id + ":" + r.id },
  categorias: { global: false, onConflict: "empresa_id,id", clave: (r) => r.empresa_id + ":" + r.id },
  recetas:    { global: false, onConflict: "empresa_id,id", clave: (r) => r.empresa_id + ":" + r.id },
};
const ORDEN_SYNC = ["empresas", "usuarios", "productos", "categorias", "recetas", "ventas"];
const FECHA_EPOCA = "1970-01-01T00:00:00.000Z";

let cliente = null;
let sincronizando = false;

// ---------------------------------------------------------------------------
// Cliente Supabase (se crea una sola vez)
// ---------------------------------------------------------------------------
export function obtenerCliente() {
  if (cliente) return cliente;
  if (!window.supabase) return null;
  cliente = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return cliente;
}

async function sesionActiva() {
  const sb = obtenerCliente();
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    return data && data.session ? data.session : null;
  } catch {
    return null;
  }
}

export async function haySesionNube() {
  return !!(await sesionActiva());
}

// ---------------------------------------------------------------------------
// Vinculación de cuentas
// ---------------------------------------------------------------------------

// Vincula la cuenta local (correo + contraseña) con Supabase Auth. Si aún no
// existe la cuenta en la nube, la crea (requiere que Supabase tenga activado
// el proveedor Email y desactivada la confirmación de correo).
export async function vincularCuenta(correo, contrasena) {
  const sb = obtenerCliente();
  if (!sb) return { ok: false, error: "La nube no está disponible en este dispositivo." };
  if (!navigator.onLine) return { ok: false, error: "Sin conexión a internet." };

  try {
    const { error } = await sb.auth.signInWithPassword({ email: correo, password: contrasena });
    if (!error) return { ok: true };

    const msg = (error.message || "").toLowerCase();
    if (msg.includes("invalid login credentials")) {
      const { error: errorReg } = await sb.auth.signUp({ email: correo, password: contrasena });
      if (errorReg) {
        if (/already registered/i.test(errorReg.message)) {
          return { ok: false, error: "La cuenta de la nube tiene otra contraseña. Restablece la contraseña o usa la correcta." };
        }
        return { ok: false, error: "No se pudo crear la cuenta en la nube: " + errorReg.message };
      }
    } else {
      return { ok: false, error: error.message };
    }
  } catch (err) {
    return { ok: false, error: "Error de red al conectar con la nube." };
  }

  // Tras signUp con confirmación desactivada ya hay sesión.
  const sesion = await sesionActiva();
  if (!sesion) {
    return { ok: false, error: "Cuenta creada, pero falta confirmar el correo en Supabase (desactiva 'Confirm email')." };
  }
  return { ok: true };
}

// Inicia sesión SOLO en la nube (para activar un dispositivo nuevo que aún no
// tiene los datos locales). Usa las credenciales de Supabase Auth.
export async function bootstrapDesdeNube(correo, contrasena) {
  const sb = obtenerCliente();
  if (!sb || !navigator.onLine) return { ok: false, error: "Sin conexión a internet." };
  try {
    let { error } = await sb.auth.signInWithPassword({ email: correo, password: contrasena });
    // La cuenta de Supabase Auth se crea con el PRIMER ingreso. Si el
    // administrador creó al usuario en "usuarios" pero nunca entró, en un
    // teléfono nuevo aún no existe su cuenta: la creamos con las mismas
    // credenciales que acaba de teclear (la contraseña la fijó el admin).
    if (error) {
      const { error: errorUp } = await sb.auth.signUp({ email: correo, password: contrasena });
      if (errorUp) return { ok: false, error: "No existe una cuenta en la nube con esas credenciales." };
    }
  } catch {
    return { ok: false, error: "Error de red al conectar con la nube." };
  }
  await reclamarFilaUsuario();
  return { ok: true };
}

// Asegura que la fila del usuario en "usuarios" tenga su auth_uid. Si la fila
// no existe (primera vez), la crea con permisos seguros (solo el correo admin
// fijo puede crearse como admin).
export async function reclamarFilaUsuario() {
  const sb = obtenerCliente();
  if (!sb) return false;
  let user = null;
  try {
    const { data } = await sb.auth.getUser();
    user = data && data.user ? data.user : null;
  } catch { return false; }
  if (!user) return false;
  const email = user.email;

  // 1) Buscar la fila existente.
  const { data: filas } = await sb.from("usuarios").select("*").eq("email", email);
  const fila = (filas || [])[0];

  // 2) Si existe pero aún no tiene auth_uid, la reclamamos.
  if (fila) {
    if (!fila.auth_uid) {
      const { error } = await sb.from("usuarios")
        .update({ auth_uid: user.id })
        .eq("email", email);
      return !error;
    }
    return true;
  }

  // 3) Si no existe, la creamos SOLO si tenemos los datos locales. Sin datos
  //    locales (p. ej. dispositivo nuevo) es mejor no insertar una fila vacía
  //    con empresa_id NULL: el bootstrap lo avisará con claridad.
  let local = null;
  try { local = await leer(email, "usuarios"); } catch { local = null; }
  if (!local) return false;
  const rol = (email === "admin@konta.app" && local.rol === "admin") ? "admin" : "usuario";
  const empresa_id = local && local.empresa_id ? local.empresa_id : null;
  const datos = { ...local };
  delete datos.updated_at;
  const { error: errorIns } = await sb.from("usuarios").insert({
    email,
    auth_uid: user.id,
    rol,
    empresa_id,
    datos,
    updated_at: new Date().toISOString(),
  });
  return !errorIns;
}

// Actualiza la contraseña en la nube cuando el usuario la cambia localmente.
export async function actualizarClaveNube(nuevaContrasena) {
  const sb = obtenerCliente();
  if (!sb || !navigator.onLine) return { ok: false };
  const sesion = await sesionActiva();
  if (!sesion) return { ok: false };
  try {
    const { error } = await sb.auth.updateUser({ password: nuevaContrasena });
    return { ok: !error, error: error && error.message };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Sincronización de datos
// ---------------------------------------------------------------------------

// Prepara la fila que se envía a la nube según la tabla.
function filaParaPush(tabla, registro, nubeRow) {
  const updated_at = registro.updated_at || new Date().toISOString();
  if (tabla === "empresas") {
    return { id: registro.id, nombre: registro.nombre || "", datos: registro, updated_at, borrado: false };
  }
  if (tabla === "usuarios") {
    return {
      email: registro.email,
      auth_uid: nubeRow ? nubeRow.auth_uid : null,
      rol: nubeRow ? nubeRow.rol : (registro.rol || "usuario"),
      empresa_id: nubeRow && nubeRow.empresa_id != null ? nubeRow.empresa_id : (registro.empresa_id || null),
      datos: registro,
      updated_at,
      borrado: false,
    };
  }
  return { empresa_id: registro.empresa_id, id: registro.id, datos: registro, updated_at, borrado: false };
}

async function empujarTabla(sb, tabla, filas) {
  if (!filas.length) return;
  const config = TABLAS[tabla];
  await sb.from(tabla).upsert(filas, { onConflict: config.onConflict });
}

async function traerTabla(sb, tabla) {
  const { data, error } = await sb.from(tabla).select("*");
  if (error) throw error;
  return data || [];
}

// Mezcla una tabla entre local y nube. Devuelve true si aplicó cambios locales.
// Con opciones.soloTraer solo baja de la nube (no sube nada): lo usan los
// usuarios normales para las empresas, que solo gestiona el administrador.
async function fusionarTabla(sb, tabla, empresasIds, opciones = {}) {
  const config = TABLAS[tabla];

  // --- Leer registros locales ---------------------------------------------
  const locales = [];
  if (config.global) {
    locales.push(...(await leerTodos(tabla)));
  } else {
    for (const empId of empresasIds) {
      const filas = await leerTodosDeEmpresa(empId, tabla);
      filas.forEach((f) => { f.__empresa_id = empId; });
      locales.push(...filas);
    }
  }
  const localMap = new Map();
  for (const r of locales) {
    const empresaId = config.global ? null : r.__empresa_id;
    localMap.set(config.clave({ ...r, empresa_id: empresaId }), r);
  }

  // --- Traer la nube --------------------------------------------------------
  const nube = await traerTabla(sb, tabla);
  const nubeMap = new Map(nube.map((r) => [config.clave(r), r]));

  // --- Tumbas (borrados locales pendientes) ---------------------------------
  const tumbas = leerTumbas().filter((t) => t.tabla === tabla);
  const tumbasMap = new Map(tumbas.map((t) => [config.clave({ ...t, empresa_id: t.empresa_id }), t]));

  let aplicados = false;

  // --- Empujar locales más nuevos que la nube -------------------------------
  if (!opciones.soloTraer) {
    const aEmpujar = [];
    for (const r of locales) {
      const empresaId = config.global ? null : r.__empresa_id;
      const clave = config.clave({ ...r, empresa_id: empresaId });
      if (tumbasMap.has(clave)) continue; // fue eliminado localmente
      const nubeRow = nubeMap.get(clave);
      const localT = r.updated_at || FECHA_EPOCA;
      if (!nubeRow || localT > nubeRow.updated_at) {
        // En tablas globales (usuarios, empresas) NO se debe pisar empresa_id:
        // el registro local ya lo lleva y filaParaPush lo usa para subirlo.
        const registroPush = config.global ? r : { ...r, empresa_id: r.__empresa_id };
        aEmpujar.push(filaParaPush(tabla, registroPush, nubeRow));
      }
    }
    if (aEmpujar.length) {
      await empujarTabla(sb, tabla, aEmpujar);
      aEmpujar.forEach((f) => nubeMap.set(config.clave(f), f));
      aplicados = true;
    }
  }

  // --- Empujar tumbas (borrados locales) -------------------------------------
  if (!opciones.soloTraer) {
    for (const t of tumbas) {
      const clave = config.clave(t);
      const nubeRow = nubeMap.get(clave);
      if (nubeRow && !nubeRow.borrado && nubeRow.updated_at > t.updated_at) {
        continue; // la nube tiene una versión más nueva: se revive localmente
      }
      const base = {};
      if (tabla === "empresas") base.id = t.id;
      else if (tabla === "usuarios") base.email = t.id;
      else { base.empresa_id = t.empresa_id; base.id = t.id; }
      await empujarTabla(sb, tabla, [{ ...base, datos: {}, updated_at: t.updated_at, borrado: true }]);
      aplicados = true;
    }
  }

  // --- Aplicar la nube más nueva que lo local --------------------------------
  for (const fila of nubeMap.values()) {
    // No traer datos de empresas que ya no existen localmente (evita que el
    // admin "resucite" una empresa eliminada).
    if (!config.global && !empresasIds.includes(fila.empresa_id)) continue;

    const clave = config.clave(fila);
    const localRow = localMap.get(clave);
    const localT = (localRow && (localRow.updated_at || FECHA_EPOCA)) || FECHA_EPOCA;

    if (fila.borrado) {
      if (localRow) {
        const claveLocal = config.global ? (tabla === "usuarios" ? fila.email : fila.id) : fila.id;
        await aplicarEliminacion(tabla, claveLocal, fila.empresa_id);
        aplicados = true;
      }
      const empresaTumba = config.global ? null : fila.empresa_id;
      limpiarTumba(tabla, empresaTumba, config.global ? (tabla === "usuarios" ? fila.email : fila.id) : fila.id);
      continue;
    }

    if (!localRow || fila.updated_at > localT) {
      const reg = fila.datos && typeof fila.datos === "object" && Object.keys(fila.datos).length
        ? fila.datos
        : fila;
      await aplicarRegistro(tabla, reg, config.global ? null : fila.empresa_id);
      aplicados = true;
    }
  }

  return aplicados;
}

// Para un usuario normal, solo se sincroniza su propia fila de "usuarios"
// (el resto la gestiona el administrador).
async function fusionarFilaPropiaUsuario(sb, usuario) {
  const { data, error } = await sb.from("usuarios").select("*").eq("email", usuario.email);
  if (error) throw error;
  const fila = (data || [])[0];
  const localT = usuario.updated_at || FECHA_EPOCA;

  if (!fila) return; // la creará reclamarFilaUsuario si hace falta

  if (fila.updated_at > localT) {
    const reg = fila.datos && typeof fila.datos === "object" && Object.keys(fila.datos).length
      ? fila.datos
      : { ...usuario };
    await aplicarRegistro("usuarios", { ...reg, updated_at: fila.updated_at }, null);
  } else if (localT > fila.updated_at) {
    await empujarTabla(sb, "usuarios", [{
      email: usuario.email,
      auth_uid: fila.auth_uid || null,
      rol: fila.rol || usuario.rol || "usuario",
      empresa_id: fila.empresa_id != null ? fila.empresa_id : (usuario.empresa_id || null),
      datos: usuario,
      updated_at: localT,
      borrado: false,
    }]);
  }
}

// Sincroniza todo lo accesible para el usuario con sesión activa.
// Devuelve { ok, aplicados }.
export async function sincronizarTodo(correo) {
  const sb = obtenerCliente();
  if (!sb) return { ok: false, error: "La nube no está disponible." };
  if (!navigator.onLine) return { ok: false, error: "Sin conexión a internet." };
  if (sincronizando) return { ok: true, aplicados: false };

  sincronizando = true;
  try {
    const sesion = await sesionActiva();
    if (!sesion) return { ok: false, error: "No hay sesión en la nube. Vuelve a iniciar sesión." };

    const usuario = await leer(correo, "usuarios");
    if (!usuario) return { ok: false, error: "Cuenta local no encontrada." };
    const esAdmin = usuario.rol === "admin";

    let aplicados = false;

    // 1) Tablas globales (empresas y usuarios). Los usuarios normales solo
    //    sincronizan su propia fila.
    for (const tabla of ["empresas", "usuarios"]) {
      try {
        if (tabla === "usuarios" && !esAdmin) {
          await fusionarFilaPropiaUsuario(sb, usuario);
          continue;
        }
        const ids = esAdmin ? null : (usuario.empresa_id ? [usuario.empresa_id] : []);
        const opciones = (!esAdmin && tabla === "empresas") ? { soloTraer: true } : {};
        if (await fusionarTabla(sb, tabla, ids, opciones)) aplicados = true;
      } catch (err) {
        console.warn("Sync " + tabla + ":", err && err.message);
      }
    }

    // 2) Datos por empresa. Recalculamos las empresas después del paso 1 para
    //    que un dispositivo nuevo traiga los datos tras bajar la lista.
    const empresas = await listarEmpresas();
    const empresasIds = esAdmin
      ? empresas.map((e) => e.id)
      : (usuario.empresa_id ? [usuario.empresa_id] : []);

    for (const tabla of ["productos", "categorias", "recetas", "ventas"]) {
      try {
        if (await fusionarTabla(sb, tabla, empresasIds)) aplicados = true;
      } catch (err) {
        console.warn("Sync " + tabla + ":", err && err.message);
      }
    }

    localStorage.setItem("konta_sync_ultima", new Date().toISOString());
    return { ok: true, aplicados };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : "Error de sincronización." };
  } finally {
    sincronizando = false;
  }
}

// Exporta el orden para depuración.
export { ORDEN_SYNC };