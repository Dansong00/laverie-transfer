import type { en } from "./en";

export const es = {
  profile: "Perfil",
  name: "Nombre",
  role: "Rol",
  admin: "Administrador",
  staff: "Personal",
  phone: "Número registrado",
  board: "Tablero de traslados",
  orders: "Pedidos elegibles",
  directory: "Administración del personal",
  signOut: "Cerrar sesión",
  language: "Idioma",
  saveLanguage: "Guardar idioma",
} satisfies Record<keyof typeof en, string>;
