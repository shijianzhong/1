import { z } from 'zod'
import { registerTool } from '../registry'

// —— AI腔逐句规则预筛（内容生产 §2.2 + §2.5 两层架构第一层）——
// 理念（吸收 Roland《我找到了AI写作问题的根源》）：AI腔不是"用了哪些常用词"，
//   是"句子与原材料之间的关系出了问题"。规则只做定位不判断（透明、可解释、零 LLM 成本），
//   定性交给 A6 reviewer agent + review-discipline §2.5。
//
// 两类根源：
//   A self_invented_term（自造说法）：比喻/行话给普通事实换名字，删掉不损失信息。
//     规则：扫"X发生了Y/陷入Y/上演Y/进入Y状态/释放Y红利/打通Y/重构Y"等抽象动宾，
//           命中即标"自造说法候选，待 A6 核是否只是给普通事实换名字"。
//   B english_connection_misuse（英译式连接词）：反映出/体现出/表明了/揭示了/这意味着/由此可见
//     造成语法+证据双错位。规则：逐个连接词定位，标前后句关系待核。
//
// 输出：透明命中清单（原句 + 根源类型 + 命中词 + 改写方向），不替 LLM 做最终判断。
// 命中 ≥3 处 → capped=true 提示 A6 真实感维封顶 1 分 + 需逐句改。

/** 根源B 连接词清单（英译式话语连接） */
const ENGLISH_CONNECTIONS = [
  '反映出',
  '体现出',
  '表明了',
  '揭示了',
  '这意味着',
  '由此可见',
  '说明了一件事',
  '足以证明',
  '恰恰说明',
  '不难看出',
  '充分说明',
  '足以说明',
]

/** 根源A 自造说法模式：抽象动宾 / 拟人化商业隐喻
 *  动词与宾语间允许少量修饰词（≤6 字符），如"释放了巨大的红利" */
const SELF_INVENTED_PATTERNS: Array<{ re: RegExp; marker: string }> = [
  // 塌方/重构/赋能/打通/闭环/抓手/沉淀/对齐/拉齐/串联/释放 等抽象动宾
  { re: /(发生|陷入|上演|迎来|触发)[^。！？\n]{0,6}?(塌方|重构|裂变|质变|跃迁|迭代)/g, marker: '抽象事件化' },
  { re: /(打通|串联|对齐|拉齐|沉淀|聚拢|撬动|盘活)[^。！？\n]{0,6}?(全链路|上下游|数据孤岛|生态|壁垒|闭环)/g, marker: '商业黑话动宾' },
  { re: /(释放|激发|唤醒|点燃|引爆)[^。！？\n]{0,6}?(红利|潜能|势能|动能|活力|想象力)/g, marker: '抽象红利/潜能' },
  { re: /(进入|迈向|开启|拥抱|踏上)[^。！？\n]{0,6}?(新纪元|新阶段|下半场|深水区|无人区|快车道)/g, marker: '阶段化隐喻' },
  { re: /(死掉|活下来|倒下|跑出来|冲出来)/g, marker: '拟人化商业叙事' },
  // "…的底层逻辑/本质/真相" 强行归因
  { re: /(底层逻辑|本质真相|核心秘密|真正的原因|背后的真相)/g, marker: '强行归因到本质' },
  // "成本塌方""信息茧房""认知…" 抽象容器
  { re: /(信息茧房|认知壁垒|思维定式|知识断层|能力天花板)/g, marker: '抽象容器词' },
]

interface AuditHit {
  sentence: string
  type: 'self_invented_term' | 'english_connection_misuse'
  marker: string
  suggestion: string
}

/** 按句切分：中文句号/问号/叹号 + 换行 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function registerAiCavityTools(): void {
  registerTool(
    'ai_cavity_audit',
    'AI腔逐句规则预筛（零 LLM 成本，透明可解释）。输入文章正文，逐句扫两类根源：① 自造说法（比喻/行话给普通事实换名字）；② 英译式连接词（反映出/体现出/表明了等造成语法+证据双错位）。输出透明命中清单（原句+根源+命中词+改写方向），不替 LLM 做最终判断——定性交 A6 reviewer。命中 ≥3 处 → capped=true（提示真实感维封顶1分、需逐句改）。这是两层 AI腔检测的第一层，第二层是 A6 agent 语义判断。',
    z.object({
      text: z.string().min(1).describe('待诊断的中文文章正文'),
    }),
    async (args) => {
      const { text } = args as { text: string }
      if (!text || text.trim().length === 0) {
        return { ok: false, error: 'empty', messageKey: 'errors.tools.ai_cavity_empty' }
      }
      const sentences = splitSentences(text)
      const hits: AuditHit[] = []
      for (const sentence of sentences) {
        // —— 根源B：英译式连接词 ——
        for (const conn of ENGLISH_CONNECTIONS) {
          if (sentence.includes(conn)) {
            hits.push({
              sentence,
              type: 'english_connection_misuse',
              marker: conn,
              suggestion: `删掉"${conn}"，前后两句分开读：前面是可确认的事实吗？后面是另一个事实还是解释/结论？原材料真的建立了这层关系吗？按支持程度重写（确认了原因→"原因是"；同时出现→"与…同时出现"；仅一种可能→"可能与…有关"；没建立→连接词和解释一并删）。`,
            })
            break // 每句每类只记一次，避免重复
          }
        }
        // —— 根源A：自造说法 ——
        for (const { re, marker } of SELF_INVENTED_PATTERNS) {
          // 重置 lastIndex（全局正则在循环里复用需重置）
          const r = new RegExp(re.source, re.flags)
          if (r.test(sentence)) {
            // 避免与根源B同句重复记录太多——根源A 独立记
            hits.push({
              sentence,
              type: 'self_invented_term',
              marker,
              suggestion: `问"这说的就是哪个普通事实？"。换回普通事实后信息不丢 → 删比喻/行话，写普通事实（如"成本塌方"→"成本大幅下降"）。`,
            })
            break
          }
        }
      }
      const capped = hits.length >= 3
      return {
        ok: true,
        totalHits: hits.length,
        capped, // true → 提示 A6 真实感维封顶 1 + 需逐句改
        hits,
        rule: '命中≥3 处 → 真实感维封顶 1 分并标"需返工逐句改"。本工具只定位不判断，定性交 A6 reviewer + review-discipline §2.5。',
      }
    },
  )
}
