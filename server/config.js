// Small env helpers (read live so tests and .env reloads behave).
const e = process.env;
export const str = (k, d = '') => (e[k] !== undefined && e[k] !== '' ? e[k] : d);
export const num = (k, d) => { const v = Number(e[k]); return e[k] !== undefined && e[k] !== '' && Number.isFinite(v) ? v : d; };
export const flag = (k, d = false) => (e[k] === undefined || e[k] === '' ? d : /^(1|true|yes|on)$/i.test(e[k]));
export const list = (k, d = '') => str(k, d).split(',').map((s) => s.trim()).filter(Boolean);
