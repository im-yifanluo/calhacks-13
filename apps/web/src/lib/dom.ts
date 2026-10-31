/** The element with this id, typed by the caller. Pages look up only ids their own HTML defines. */
export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
