/*
 * auth.js - Autenticación de Konta (multi-empresa).
 * La app funciona sin conexión (IndexedDB), así que las cuentas se guardan
 * localmente en el dispositivo. Para recuperar la contraseña se usa una
 * pregunta de seguridad (no requiere servidor ni correo).
 *
 * Hay un administrador global (admin@konta.app) que gestiona las empresas y
 * los usuarios. Los usuarios creados por el administrador deben cambiar su
 * contraseña la primera vez que inician sesión.
 *
 * Las contraseñas y respuestas se guardan como hash SHA-256.
 */

import { leer, guardar, eliminar, leerTodos } from "./db.js";

const SESION_CLAVE = "konta_sesion";
const STORE = "usuarios";

// ---------------------------------------------------------------------------
// Hash SHA-256
// ---------------------------------------------------------------------------
// Preferimos crypto.subtle (asíncrono) cuando está disponible (https o
// localhost). En el celular la app puede abrirse por HTTP desde la red local,
// donde crypto.subtle no existe: usamos entonces una implementación en JS puro
// que produce exactamente el mismo resultado.

function sha256JS(texto) {
  const chrsz = 8;
  const hexcase = 0;
  function safe_add(x, y) {
    const lsw = (x & 0xFFFF) + (y & 0xFFFF);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }
  function S(X, n) { return (X >>> n) | (X << (32 - n)); }
  function R(X, n) { return (X >>> n); }
  function Ch(x, y, z) { return ((x & y) ^ ((~x) & z)); }
  function Maj(x, y, z) { return ((x & y) ^ (x & z) ^ (y & z)); }
  function Sigma0256(x) { return (S(x, 2) ^ S(x, 13) ^ S(x, 22)); }
  function Sigma1256(x) { return (S(x, 6) ^ S(x, 11) ^ S(x, 25)); }
  function Gamma0256(x) { return (S(x, 7) ^ S(x, 18) ^ R(x, 3)); }
  function Gamma1256(x) { return (S(x, 17) ^ S(x, 19) ^ R(x, 10)); }
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function core_sha256(m, l) {
    const HASH = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const W = new Array(64);
    let a, b, c, d, e, f, g, h, T1, T2;
    m[l >> 5] |= 0x80 << (24 - (l % 32));
    m[((l + 64 >> 9) << 4) + 15] = l;
    for (let i = 0; i < m.length; i += 16) {
      a = HASH[0]; b = HASH[1]; c = HASH[2]; d = HASH[3];
      e = HASH[4]; f = HASH[5]; g = HASH[6]; h = HASH[7];
      for (let j = 0; j < 64; j++) {
        if (j < 16) W[j] = m[j + i];
        else W[j] = safe_add(safe_add(safe_add(Gamma1256(W[j - 2]), W[j - 7]), Gamma0256(W[j - 15])), W[j - 16]);
        T1 = safe_add(safe_add(safe_add(safe_add(h, Sigma1256(e)), Ch(e, f, g)), K[j]), W[j]);
        T2 = safe_add(Sigma0256(a), Maj(a, b, c));
        h = g; g = f; f = e; e = safe_add(d, T1);
        d = c; c = b; b = a; a = safe_add(T1, T2);
      }
      HASH[0] = safe_add(a, HASH[0]); HASH[1] = safe_add(b, HASH[1]);
      HASH[2] = safe_add(c, HASH[2]); HASH[3] = safe_add(d, HASH[3]);
      HASH[4] = safe_add(e, HASH[4]); HASH[5] = safe_add(f, HASH[5]);
      HASH[6] = safe_add(g, HASH[6]); HASH[7] = safe_add(h, HASH[7]);
    }
    return HASH;
  }
  function str2binb(str) {
    const bin = [];
    const mask = (1 << chrsz) - 1;
    for (let i = 0; i < str.length * chrsz; i += chrsz) {
      bin[i >> 5] |= (str.charCodeAt(i / chrsz) & mask) << (24 - (i % 32));
    }
    return bin;
  }
  function utf8(str) {
    return unescape(encodeURIComponent(str));
  }
  function binb2hex(binarray) {
    const hex_tab = hexcase ? "0123456789ABCDEF" : "0123456789abcdef";
    let str = "";
    for (let i = 0; i < binarray.length * 4; i++) {
      str += hex_tab.charAt((binarray[i >> 2] >> ((3 - (i % 4)) * 8 + 4)) & 0xF) +
        hex_tab.charAt((binarray[i >> 2] >> ((3 - (i % 4)) * 8)) & 0xF);
    }
    return str;
  }
  const s = utf8(texto);
  return binb2hex(core_sha256(str2binb(s), s.length * chrsz));
}

// Devuelve el hash SHA-256 en hex de un texto, usando crypto.subtle cuando está
// disponible y la implementación JS en caso contrario.
async function hashTexto(texto) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const datos = new TextEncoder().encode(texto);
      const digest = await crypto.subtle.digest("SHA-256", datos);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      // si falla, usamos el fallback JS
    }
  }
  return sha256JS(texto);
}

// Normaliza el correo (minúsculas, sin espacios) y valida su forma.
function normalizarCorreo(correo) {
  const c = String(correo || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return null;
  return c;
}

// ---------------------------------------------------------------------------
// Usuario administrador global
// ---------------------------------------------------------------------------

// Crea el administrador inicial si todavía no existe.
// Credenciales por defecto: admin@konta.app / admin123 (debe cambiarla al
// primer ingreso).
async function sembrarAdminInicial() {
  const admin = await leer("admin@konta.app", STORE);
  if (admin) return { ok: true, creado: false };

  const usuario = {
    email: "admin@konta.app",
    nombre: "Administrador",
    password_hash: await hashTexto("admin@konta.app|admin123"),
    pregunta: "¿Cuál es el nombre de tu primera mascota?",
    respuesta_hash: await hashTexto("admin@konta.app|admin"),
    rol: "admin",
    empresa_id: null,
    debe_cambiar_clave: true,
    creado: Date.now(),
  };
  await guardar(usuario, STORE);
  return { ok: true, creado: true };
}

// ---------------------------------------------------------------------------
// Gestión de usuarios (solo el administrador)
// ---------------------------------------------------------------------------

// Crea un usuario normal para una empresa. La primera vez que inicie sesión
// deberá cambiar su contraseña (debe_cambiar_clave = true).
async function crearUsuario({ correo, nombre, contrasena, empresa_id, pregunta, respuesta }) {
  const c = normalizarCorreo(correo);
  if (!c) return { ok: false, error: "Correo no válido." };
  if (!nombre || !nombre.trim()) return { ok: false, error: "Escribe el nombre." };
  if (!contrasena || contrasena.length < 4) return { ok: false, error: "La contraseña debe tener al menos 4 caracteres." };
  if (!empresa_id) return { ok: false, error: "Selecciona la empresa del usuario." };
  if (!pregunta || !respuesta || !respuesta.trim()) return { ok: false, error: "Configura una pregunta de seguridad." };

  const existe = await leer(c, STORE);
  if (existe) return { ok: false, error: "Ya existe una cuenta con ese correo." };

  const usuario = {
    email: c,
    nombre: nombre.trim(),
    password_hash: await hashTexto(c + "|" + contrasena),
    pregunta,
    respuesta_hash: await hashTexto(c + "|" + respuesta.trim().toLowerCase()),
    rol: "usuario",
    empresa_id: Number(empresa_id),
    debe_cambiar_clave: true,
    creado: Date.now(),
  };
  await guardar(usuario, STORE);
  return { ok: true, usuario };
}

// Cambia la contraseña de un usuario (también al restablecerla o al forzarla
// en el primer ingreso).
async function cambiarContrasena(correo, nuevaContrasena) {
  const c = normalizarCorreo(correo);
  if (!c) return { ok: false, error: "Correo no válido." };
  if (!nuevaContrasena || nuevaContrasena.length < 4) {
    return { ok: false, error: "La contraseña debe tener al menos 4 caracteres." };
  }
  const usuario = await leer(c, STORE);
  if (!usuario) return { ok: false, error: "No existe una cuenta con ese correo." };

  usuario.password_hash = await hashTexto(c + "|" + nuevaContrasena);
  usuario.debe_cambiar_clave = false;
  await guardar(usuario, STORE);
  return { ok: true };
}

// Elimina un usuario.
async function eliminarUsuario(correo) {
  const c = normalizarCorreo(correo);
  if (!c) return { ok: false };
  if (c === "admin@konta.app") return { ok: false, error: "No se puede eliminar el administrador." };
  await eliminar(c, STORE);
  return { ok: true };
}

// Lista los usuarios de una empresa (o todos si no se filtra).
async function listarUsuarios(empresaId) {
  const todos = await leerTodos(STORE);
  if (empresaId) return todos.filter((u) => u.empresa_id === Number(empresaId));
  return todos;
}

// ---------------------------------------------------------------------------
// Inicio de sesión
// ---------------------------------------------------------------------------

// Inicia sesión. Devuelve { ok:true, usuario, requiereCambio } o { ok:false, error }.
// empresa_id es la empresa elegida en el formulario de login: para usuarios
// normales debe coincidir con su empresa.
async function iniciarSesion(correo, contrasena, empresa_id) {
  const c = normalizarCorreo(correo);
  if (!c) return { ok: false, error: "Correo no válido." };

  const usuario = await leer(c, STORE);
  if (!usuario) return { ok: false, error: "No existe una cuenta con ese correo." };

  const hash = await hashTexto(c + "|" + contrasena);
  if (hash !== usuario.password_hash) return { ok: false, error: "Contraseña incorrecta." };

  // Un usuario normal solo puede entrar a su empresa.
  if (usuario.rol !== "admin") {
    if (!empresa_id) return { ok: false, error: "Selecciona tu empresa." };
    if (Number(empresa_id) !== Number(usuario.empresa_id)) {
      return { ok: false, error: "Esta cuenta no pertenece a la empresa seleccionada." };
    }
  }

  localStorage.setItem(SESION_CLAVE, c);
  return {
    ok: true,
    usuario,
    requiereCambio: !!usuario.debe_cambiar_clave,
  };
}

// Obtiene la cuenta de la sesión actual (o null si no hay sesión).
async function obtenerSesion() {
  const correo = localStorage.getItem(SESION_CLAVE);
  if (!correo) return null;
  return leer(correo, STORE);
}

// Devuelve el correo de la sesión actual sin consultar la base de datos.
function correoSesion() {
  return localStorage.getItem(SESION_CLAVE);
}

// Cierra la sesión actual.
function cerrarSesion() {
  localStorage.removeItem(SESION_CLAVE);
}

// ---------------------------------------------------------------------------
// Recuperación de contraseña (pregunta de seguridad)
// ---------------------------------------------------------------------------

// Verifica la respuesta de seguridad y restablece la contraseña.
async function recuperarContrasena(correo, respuesta, nuevaContrasena) {
  const c = normalizarCorreo(correo);
  if (!c) return { ok: false, error: "Correo no válido." };
  if (!nuevaContrasena || nuevaContrasena.length < 4) {
    return { ok: false, error: "La nueva contraseña debe tener al menos 4 caracteres." };
  }

  const usuario = await leer(c, STORE);
  if (!usuario) return { ok: false, error: "No existe una cuenta con ese correo." };

  const respHash = await hashTexto(c + "|" + respuesta.trim().toLowerCase());
  if (respHash !== usuario.respuesta_hash) return { ok: false, error: "Respuesta de seguridad incorrecta." };

  usuario.password_hash = await hashTexto(c + "|" + nuevaContrasena);
  usuario.debe_cambiar_clave = false;
  await guardar(usuario, STORE);
  return { ok: true };
}

export {
  sembrarAdminInicial,
  crearUsuario,
  cambiarContrasena,
  eliminarUsuario,
  listarUsuarios,
  iniciarSesion,
  obtenerSesion,
  correoSesion,
  cerrarSesion,
  recuperarContrasena,
};