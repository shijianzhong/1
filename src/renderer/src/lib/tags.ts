/** 将 tags 数组转为逗号分隔的输入框文本 */
export function tagsToInput(tags?: string[]): string {
  return (tags ?? []).join(', ')
}

/** 将逗号分隔的输入框文本解析为去重后的 tags 数组；空则返回 undefined */
export function parseTagsInput(value?: string): string[] | undefined {
  const tags = String(value ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
  return tags.length > 0 ? Array.from(new Set(tags)) : undefined
}
