// Parse dmhy RSS and topic HTML into torrent/magnet items.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Convert magnet btih (hex or base32) to lowercase hex infohash. */
export function btihToHex(btih) {
  if (!btih) return ''
  const s = btih.trim()
  if (/^[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase()
  const up = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  if (up.length < 32) return ''
  let bits = ''
  for (const c of up.slice(0, 32)) {
    const i = BASE32.indexOf(c)
    if (i < 0) return ''
    bits += i.toString(2).padStart(5, '0')
  }
  let hex = ''
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0')
  }
  return hex.slice(0, 40)
}

export function magnetInfoHash(magnet) {
  const m = String(magnet || '').match(/[?&:]xt=urn:btih:([A-Za-z0-9]+)/i)
    || String(magnet || '').match(/btih:([A-Za-z0-9]+)/i)
  return m ? btihToHex(m[1]) : ''
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function tagText(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = block.match(re)
  return m ? decodeXml(m[1]) : ''
}

function enclosureUrl(block) {
  const m = block.match(/<enclosure[^>]*\burl=["']([^"']+)["']/i)
  return m ? decodeXml(m[1]) : ''
}

/** Build dl.dmhy.org torrent URL from pubDate + hex infohash when possible. */
export function guessTorrentUrl(pubDate, hex) {
  if (!hex || hex.length !== 40) return ''
  const d = pubDate ? new Date(pubDate) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  // dmhy torrent paths use Asia/Shanghai calendar date; try UTC and UTC+8
  const alts = []
  for (const offsetH of [8, 0]) {
    const t = new Date(d.getTime() + offsetH * 3600_000)
    const yy = t.getUTCFullYear()
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(t.getUTCDate()).padStart(2, '0')
    alts.push(`https://dl.dmhy.org/${yy}/${mm}/${dd}/${hex}.torrent`)
  }
  alts.push(`https://dl.dmhy.org/${y}/${mo}/${day}/${hex}.torrent`)
  return [...new Set(alts)][0]
}

export function guessTorrentUrlCandidates(pubDate, hex) {
  if (!hex || hex.length !== 40) return []
  const d = pubDate ? new Date(pubDate) : null
  if (!d || Number.isNaN(d.getTime())) return []
  const out = []
  for (const offsetH of [8, 0, -8]) {
    const t = new Date(d.getTime() + offsetH * 3600_000)
    const yy = t.getUTCFullYear()
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(t.getUTCDate()).padStart(2, '0')
    out.push(`https://dl.dmhy.org/${yy}/${mm}/${dd}/${hex}.torrent`)
  }
  return [...new Set(out)]
}

export function parseDmhyRss(xml) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/gi
  let m
  while ((m = re.exec(xml))) {
    const block = m[1]
    const title = tagText(block, 'title')
    const link = tagText(block, 'link')
    const pubDate = tagText(block, 'pubDate')
    const category = tagText(block, 'category')
    const author = tagText(block, 'author')
    const magnet = enclosureUrl(block)
    const infoHash = magnetInfoHash(magnet)
    items.push({
      title,
      link,
      pubDate,
      category,
      author,
      magnet,
      infoHash,
      torrentCandidates: guessTorrentUrlCandidates(pubDate, infoHash),
    })
  }
  return items
}

/** Extract //dl.dmhy.org/...torrent from a topic HTML page. */
export function parseTopicTorrentUrl(html) {
  const m = String(html || '').match(/\/\/dl\.dmhy\.org\/[^"'>\s]+\.torrent/i)
    || String(html || '').match(/https?:\/\/dl\.dmhy\.org\/[^"'>\s]+\.torrent/i)
  if (!m) return ''
  const raw = m[0]
  return raw.startsWith('//') ? 'https:' + raw : raw
}

export function safeFileBase(title, infoHash) {
  const hash = (infoHash || 'unknown').slice(0, 12)
  let name = String(title || 'dmhy-item')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  if (!name) name = 'dmhy-item'
  return `${name}__${hash}`
}
