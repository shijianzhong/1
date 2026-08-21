// —— HTML 文本化共享 helper（web 工具与 KB 抽取共用，review #11）——
// 此前 web.ts 与 vector/extract.ts 各自私有 stripTags，且 extract 的实体解码
// 只覆盖 6 个实体（web.ts 的超集子集），docx/HTML 摄取丢 &hellip;/&mdash; 等。
// 单一真相源在此，两处 import。

/** 剥所有 HTML 标签（保留纯文本内容） */
export function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

/** HTML 实体解码：named + decimal + hex（&#x27; / &#39; / &amp; 等） */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", '#x2F': '/',
    nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–',
  }
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, entity: string) => {
    if (named[entity]) return named[entity]
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10))
    return m
  })
}
