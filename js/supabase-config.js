/*
 * supabase-config.js - Configuración del proyecto Supabase de Konta.
 * La clave publishable/anon es pública por diseño (segura para el navegador).
 */

export const SUPABASE_URL = "https://zesjydxzaiiwmgwcwkaf.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_EcRJDD_xP7Q1aColYld6Eg_A0CrGDuT";

// Modo local: la app funciona solo en este teléfono, sin nube ni sincronización.
// Los datos se guardan únicamente en el dispositivo (IndexedDB).
export const MODO_LOCAL = true;