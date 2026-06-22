// Sync (relay) server presets, shared by the app UI and the watch page.
// Each preset has a short `key` so share links can carry `&relay=test` instead
// of a full `wss://…` URL.
export const WS_PRESETS = [
  { key: 'plateau', label: 'PLATEAU · ws.flow.plateau.reearth.io', url: 'wss://ws.flow.plateau.reearth.io' },
  { key: 'prod',    label: 'Prod · ws.flow.reearth.io',            url: 'wss://ws.flow.reearth.io' },
  { key: 'test',    label: 'Test · ws.flow.test.reearth.dev',      url: 'wss://ws.flow.test.reearth.dev' },
  { key: 'dev',     label: 'Dev · ws.flow.dev.reearth.io',         url: 'wss://ws.flow.dev.reearth.io' },
]

// URL → short code for share links (known preset → its key; custom → raw url).
export function encodeRelay(url) {
  const p = WS_PRESETS.find(p => p.url === url)
  return p ? p.key : url
}
// short code → URL (key → preset url; otherwise treat the code as a raw url).
export function decodeRelay(code) {
  if (!code) return null
  const p = WS_PRESETS.find(p => p.key === code)
  return p ? p.url : code
}
