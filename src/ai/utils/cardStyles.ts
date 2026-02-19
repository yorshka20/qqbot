// Card styles - optimized version with proper clipping and better visuals

export const cardStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
    margin: 0;
    padding: 30px;
    background: transparent;
    min-height: 100vh;
  }
  
  .container {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 24px;
    padding: 30px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    width: 800px;
    box-sizing: border-box;
  }
  
  .card-inner {
    background: white;
    border-radius: 16px;
    padding: 35px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.1);
  }

  /* 问答卡片 */
  .qa-card {
    background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
    border-radius: 16px;
    padding: 28px;
    margin: 0;
    box-shadow: 0 4px 12px rgba(0,0,0,0.05);
  }
  .question {
    display: flex;
    align-items: center;
    margin-bottom: 24px;
    font-size: 19px;
    font-weight: 600;
    color: #2c3e50;
  }
  .q-icon {
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: white;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    margin-right: 14px;
    flex-shrink: 0;
    font-size: 16px;
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
  }
  .answer {
    display: flex;
    align-items: flex-start;
  }
  .a-icon {
    background: linear-gradient(135deg, #764ba2, #667eea);
    color: white;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    margin-right: 14px;
    flex-shrink: 0;
    font-size: 16px;
    box-shadow: 0 4px 12px rgba(118, 75, 162, 0.3);
  }
  .answer-content {
    line-height: 1.9;
    color: #2c3e50;
    font-size: 16px;
    white-space: pre-wrap;
    word-wrap: break-word;
    flex: 1;
  }
  
  .answer-content br {
    display: block;
    content: "";
    margin-top: 0.6em;
  }

  /* 列表卡片 */
  .list-card {
    margin: 0;
  }
  .list-card h2 {
    color: #2c3e50;
    margin-bottom: 24px;
    font-size: 24px;
    padding-bottom: 12px;
    border-bottom: 3px solid;
    border-image: linear-gradient(90deg, #667eea, #764ba2) 1;
  }
  .styled-list {
    list-style: none;
  }
  .styled-list li {
    display: flex;
    align-items: flex-start;
    padding: 16px 18px;
    margin: 12px 0;
    background: #f8f9fa;
    border-radius: 12px;
    transition: all 0.3s;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  }
  .styled-list li:hover {
    background: #e9ecef;
    transform: translateX(5px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.08);
  }
  .styled-list .number {
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: white;
    min-width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 15px;
    margin-right: 14px;
    flex-shrink: 0;
    box-shadow: 0 3px 10px rgba(102, 126, 234, 0.3);
  }
  .styled-list li span:last-child {
    line-height: 1.7;
    color: #2c3e50;
  }

  /* 信息框 */
  .info-box {
    padding: 24px;
    border-radius: 12px;
    margin: 0;
    border-left: 5px solid;
    box-shadow: 0 4px 12px rgba(0,0,0,0.06);
  }
  .info-box.info {
    background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
    border-color: #2196f3;
  }
  .info-box.warning {
    background: linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%);
    border-color: #ff9800;
  }
  .info-box.success {
    background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
    border-color: #4caf50;
  }
  .info-box.tip {
    background: linear-gradient(135deg, #f3e5f5 0%, #e1bee7 100%);
    border-color: #9c27b0;
  }
  .info-header {
    display: flex;
    align-items: center;
    margin-bottom: 14px;
    font-size: 17px;
    font-weight: 600;
  }
  .info-header .icon {
    font-size: 26px;
    margin-right: 12px;
  }
  .info-content {
    line-height: 1.8;
    color: #2c3e50;
    font-size: 15px;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  
  .info-content br {
    display: block;
    content: "";
    margin-top: 0.6em;
  }

  /* 对比表格 */
  .comparison-card h2 {
    color: #2c3e50;
    margin-bottom: 24px;
    font-size: 22px;
  }
  .comparison-table {
    width: 100%;
    border-collapse: collapse;
    margin: 0;
    box-shadow: 0 4px 12px rgba(0,0,0,0.06);
    border-radius: 12px;
    overflow: hidden;
  }
  .comparison-table th {
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: white;
    padding: 16px;
    text-align: left;
    font-weight: 600;
    font-size: 15px;
  }
  .comparison-table td {
    padding: 16px;
    border-bottom: 1px solid #e0e0e0;
    background: white;
    font-size: 15px;
  }
  .comparison-table tr:last-child td {
    border-bottom: none;
  }
  .comparison-table tr:hover td {
    background: #f5f7fa;
  }
  .comparison-table .label {
    font-weight: 600;
    color: #667eea;
    min-width: 120px;
  }

  /* 知识卡片 */
  .knowledge-card {
    background: linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%);
    border-radius: 16px;
    padding: 32px;
    margin: 0;
    box-shadow: 0 8px 24px rgba(0,0,0,0.1);
  }
  .term-header {
    display: flex;
    align-items: center;
    margin-bottom: 20px;
  }
  .term-icon {
    font-size: 36px;
    margin-right: 14px;
  }
  .term-header h2 {
    color: #d84315;
    font-size: 26px;
    font-weight: 700;
  }
  .definition {
    background: rgba(255,255,255,0.95);
    padding: 24px;
    border-radius: 12px;
    line-height: 1.9;
    color: #2c3e50;
    margin-bottom: 18px;
    font-size: 16px;
    white-space: pre-wrap;
    word-wrap: break-word;
    box-shadow: 0 4px 12px rgba(0,0,0,0.05);
  }
  
  .definition br {
    display: block;
    content: "";
    margin-top: 0.6em;
  }
  .examples {
    background: rgba(255,255,255,0.8);
    padding: 20px;
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.05);
  }
  .examples-title {
    font-weight: 700;
    color: #d84315;
    margin-bottom: 14px;
    font-size: 16px;
  }
  .examples ul {
    list-style: none;
    padding-left: 0;
  }
  .examples li {
    padding: 10px 0;
    padding-left: 24px;
    position: relative;
    line-height: 1.7;
    color: #2c3e50;
  }
  .examples li:before {
    content: "▸";
    position: absolute;
    left: 0;
    color: #d84315;
    font-size: 16px;
    font-weight: bold;
  }

  /* 统计卡片 */
  .stats-card h2 {
    color: #2c3e50;
    margin-bottom: 28px;
    font-size: 24px;
    text-align: center;
    font-weight: 700;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 20px;
  }
  .stat-item {
    background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
    padding: 28px 20px;
    border-radius: 14px;
    text-align: center;
    transition: all 0.3s;
    box-shadow: 0 4px 12px rgba(0,0,0,0.06);
  }
  .stat-item.highlight {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
  }
  .stat-item:hover {
    transform: translateY(-6px);
    box-shadow: 0 12px 28px rgba(0,0,0,0.15);
  }
  .stat-value {
    font-size: 36px;
    font-weight: 800;
    margin-bottom: 10px;
    color: #2c3e50;
  }
  .stat-item.highlight .stat-value {
    color: white;
  }
  .stat-label {
    font-size: 15px;
    opacity: 0.85;
    font-weight: 500;
  }

  strong { 
    color: #667eea; 
    font-weight: 700; 
  }
  
  em { 
    color: #764ba2; 
    font-style: normal; 
    background: rgba(118, 75, 162, 0.1);
    padding: 3px 8px; 
    border-radius: 4px;
    font-weight: 500;
  }
  
  /* Ensure strong and em work in all contexts */
  .answer-content strong,
  .info-content strong,
  .definition strong {
    color: #667eea;
    font-weight: 700;
  }
  
  .answer-content em,
  .info-content em,
  .definition em {
    color: #764ba2;
    font-style: normal;
    background: rgba(118, 75, 162, 0.1);
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 500;
  }

  /* Content HTML: inline code */
  .answer-content code,
  .info-content code,
  .definition code,
  .styled-list li span:last-child code,
  .comparison-table td code {
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 0.9em;
    background: rgba(0,0,0,0.06);
    padding: 2px 6px;
    border-radius: 4px;
    word-break: break-all;
  }
  .answer-content pre,
  .info-content pre,
  .definition pre {
    margin: 12px 0;
    padding: 14px 16px;
    background: rgba(0,0,0,0.06);
    border-radius: 8px;
    overflow-x: auto;
    font-family: "Consolas", "Monaco", "Courier New", monospace;
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .answer-content pre code,
  .info-content pre code,
  .definition pre code {
    background: none;
    padding: 0;
  }
  /* Content HTML: headings (smaller than card title) */
  .answer-content h2,
  .info-content h2,
  .definition h2 {
    font-size: 1.05em;
    margin: 16px 0 10px 0;
    font-weight: 700;
    color: #2c3e50;
  }
  .answer-content h3,
  .info-content h3,
  .definition h3 {
    font-size: 1em;
    margin: 14px 0 8px 0;
    font-weight: 600;
    color: #2c3e50;
  }
  /* Content HTML: paragraphs */
  .answer-content p,
  .info-content p,
  .definition p {
    line-height: 1.9;
    margin: 10px 0;
    color: #2c3e50;
    font-size: inherit;
  }
  /* Content HTML: lists inside content */
  .answer-content ul,
  .info-content ul,
  .definition ul,
  .answer-content ol,
  .info-content ol,
  .definition ol {
    margin: 10px 0;
    padding-left: 24px;
  }
  .answer-content ul { list-style-type: disc; }
  .answer-content ol { list-style-type: decimal; }
  .info-content ul { list-style-type: disc; }
  .info-content ol { list-style-type: decimal; }
  .definition ul { list-style-type: disc; }
  .definition ol { list-style-type: decimal; }
  .answer-content li,
  .info-content li,
  .definition li {
    margin: 6px 0;
    line-height: 1.7;
  }
  /* Content HTML: table (optional class content-table) */
  .answer-content table,
  .info-content table,
  .definition table,
  .answer-content table.content-table,
  .info-content table.content-table,
  .definition table.content-table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    border-radius: 8px;
    overflow: hidden;
  }
  .answer-content th,
  .info-content th,
  .definition th,
  .answer-content td,
  .info-content td,
  .definition td {
    padding: 10px 14px;
    border: 1px solid #e0e0e0;
    text-align: left;
  }
  .answer-content thead th,
  .info-content thead th,
  .definition thead th {
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: white;
    font-weight: 600;
  }

  .footer {
    margin-top: 28px;
    padding-top: 18px;
    border-top: 2px solid #e8e8e8;
    text-align: center;
    color: #999;
    font-size: 13px;
    opacity: 0.8;
  }

  h2 { 
    margin: 24px 0 18px 0; 
    font-weight: 700;
  }
  
  p { 
    line-height: 1.9; 
    margin: 14px 0; 
    color: #2c3e50;
    font-size: 16px;
  }

  /* Twemoji 图片样式 */
  img.emoji {
    height: 1.25em;
    width: 1.25em;
    margin: 0 .05em 0 .1em;
    vertical-align: -0.15em;
    display: inline-block;
  }
`;
