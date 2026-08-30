const url = `${String(process.env.PUBLIC_BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '')}/health`;
const response = await fetch(url).catch(() => null);
if (!response?.ok) { console.error(`Araru Server is unavailable at ${url}.`); process.exit(1); }
console.log(await response.text());
