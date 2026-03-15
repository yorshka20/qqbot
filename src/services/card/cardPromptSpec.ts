// Card type spec for LLM convert_to_card prompt - single source of truth for JSON format description

/**
 * One card type entry for prompt: type key, display name, description, example JSON, optional note.
 */
export interface CardTypeSpecEntry {
  type: string;
  name: string;
  description: string;
  exampleJson: string;
  optionalNote?: string;
}

/**
 * All card types with their JSON examples. Keep in sync with cardTypes.ts and cardTemplates.ts.
 */
export const CARD_TYPE_SPECS: CardTypeSpecEntry[] = [
  {
    type: 'qa',
    name: '基础问答',
    description: 'qa',
    exampleJson: '{"type":"qa","question":"用户的问题","answer":"回答内容"}',
  },
  {
    type: 'list',
    name: '列表/步骤',
    description: 'list',
    exampleJson: '{"type":"list","title":"标题","emoji":"📋","items":["第一项","第二项"]}',
  },
  {
    type: 'info',
    name: '提示/警告',
    description: 'info',
    exampleJson: '{"type":"info","title":"标题","content":"详细内容","level":"info"}',
    optionalNote: '`level` 可选值：`info` `warning` `success` `tip`',
  },
  {
    type: 'comparison',
    name: '对比分析',
    description: 'comparison',
    exampleJson:
      '{"type":"comparison","title":"对比主题","leftHeader":"方案A","rightHeader":"方案B","items":[{"label":"维度","left":"选项A内容","right":"选项B内容"}]}',
    optionalNote:
      '`leftHeader`、`rightHeader` 为两列标题，表示被比较的两方（如方案名、产品名等），不要写死为“优点/缺点”。',
  },
  {
    type: 'knowledge',
    name: '知识解释',
    description: 'knowledge',
    exampleJson: '{"type":"knowledge","term":"术语","definition":"解释","examples":["例子1","例子2"]}',
    optionalNote: '`examples` 可选。',
  },
  {
    type: 'stats',
    name: '数据统计',
    description: 'stats',
    exampleJson: '{"type":"stats","title":"标题","data":[{"label":"指标","value":"100","highlight":true}]}',
    optionalNote: '`highlight` 可选。',
  },
  {
    type: 'quote',
    name: '引用/金句',
    description: 'quote',
    exampleJson: '{"type":"quote","text":"引用的核心句子，可含<strong>强调</strong>","source":"出处（可选）"}',
    optionalNote: '`source` 可选。适合名言、结论金句、重点摘录。',
  },
  {
    type: 'steps',
    name: '步骤流',
    description: 'steps',
    exampleJson: '{"type":"steps","title":"操作步骤","steps":["第一步","第二步","第三步"]}',
    optionalNote: '适合教程、操作指南、时间线式流程。',
  },
  {
    type: 'highlight',
    name: '高亮结论',
    description: 'highlight',
    exampleJson:
      '{"type":"highlight","title":"结论标题","summary":"一句话核心结论","detail":"补充说明（可选，可含 HTML）"}',
    optionalNote: '`detail` 可选。适合单条醒目结论、要点总结。',
  },
  {
    type: 'paragraph',
    name: '自然段落',
    description: 'paragraph',
    exampleJson: '{"type":"paragraph","content":"<p>这是一段自然语言表达，保留原文的连贯叙述。</p>"}',
    optionalNote:
      '用于承载原文中的自然语言段落、过渡句、总结语等非结构化内容。content 内使用 HTML（`<p>`、`<strong>`、`<em>`、`<code>` 等）。',
  },
];

/**
 * Build the "输出形式" note for the convert_to_card prompt (single card vs array of cards).
 * Inject as {{cardDeckNote}} so prompt stays in sync with parseCardDeck behavior.
 */
export function getCardDeckNoteForPrompt(): string {
  return [
    '**输出形式：** 始终返回一个 JSON 数组，数组项为卡片对象。单卡即 `[一张卡]`，多卡即 `[卡1, 卡2, ...]`，按顺序从上到下渲染成一张图。',
    '单卡示例：`[{"type":"qa","question":"...","answer":"..."}]`',
    '多卡示例：`[{"type":"qa",...},{"type":"list","title":"...","items":[...]}]`',
    '若所用接口仅支持单个 JSON 对象（非数组），请用 `{"result": [卡片数组]}` 包裹，例如：`{"result":[{"type":"qa",...}]}`。',
  ].join('\n');
}

/**
 * Build the "卡片类型" section text for the convert_to_card prompt.
 * Inject this as {{cardTypeSpec}} so prompt stays in sync with type definitions.
 */
export function getCardTypeSpecForPrompt(): string {
  const lines: string[] = [];

  CARD_TYPE_SPECS.forEach((entry, index) => {
    const num = index + 1;
    lines.push(`**${num}. ${entry.name} \`${entry.type}\`**`);
    lines.push('```');
    lines.push(entry.exampleJson);
    lines.push('```');
    if (entry.optionalNote) {
      lines.push(entry.optionalNote);
    }
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}
