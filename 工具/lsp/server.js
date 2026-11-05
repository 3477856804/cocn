#!/usr/bin/env node
/**
 * coCN 基础 LSP 服务器（纯 Node.js，无外部依赖）
 *
 * 协议：JSON-RPC 2.0 over stdio，使用 LSP 的 Content-Length 分帧。
 *
 * 支持能力：
 *   - textDocument/didOpen / didChange：维护文档内容
 *   - textDocument/definition：跳转函数定义（匹配「函数 名」或「名 = 函数」模式）
 *   - textDocument/hover：悬停显示标识符附近的类型标注
 *   - textDocument/diagnostics：写入临时文件，调用 bin/cocn.js 捕获 stderr
 *
 * 用法：node server.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------- 文档存储 ----------
/** @type {Map<string, {text: string, version: number}>} */
const documents = new Map();

// ---------- 项目根目录检测 ----------
// server.js 位于 <项目根>/lsp/server.js
const PROJECT_ROOT = path.resolve(__dirname, '..');
const COCN_JS = path.join(PROJECT_ROOT, 'bin', 'cocn.js');

// ---------- JSON-RPC 分帧（使用 Buffer 按字节处理，兼容中文）----------
let rpcBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  rpcBuffer = Buffer.concat([rpcBuffer, chunk]);
  // 查找 \r\n\r\n（头部与正文的分隔）
  while (true) {
    const sepIdx = rpcBuffer.indexOf('\r\n\r\n');
    if (sepIdx === -1) break;
    const headerSection = rpcBuffer.slice(0, sepIdx).toString('utf8');
    const m = headerSection.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      // 无效头部，跳过这一段
      rpcBuffer = rpcBuffer.slice(sepIdx + 4);
      continue;
    }
    const contentLength = parseInt(m[1], 10);
    const bodyStart = sepIdx + 4;
    if (rpcBuffer.length < bodyStart + contentLength) break; // 等待更多数据
    const bodyBuf = rpcBuffer.slice(bodyStart, bodyStart + contentLength);
    rpcBuffer = rpcBuffer.slice(bodyStart + contentLength);
    try {
      const msg = JSON.parse(bodyBuf.toString('utf8'));
      handleMessage(msg);
    } catch (e) {
      console.error('[LSP] 解析消息失败:', e.message);
    }
  }
});

function sendResponse(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  writeRpc(body);
}

function sendError(id, code, message) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  writeRpc(body);
}

function sendNotification(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  writeRpc(body);
}

function writeRpc(body) {
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

// ---------- 消息分发 ----------
function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        capabilities: {
          textDocumentSync: 1, // Full sync
          definitionProvider: true,
          hoverProvider: true,
          diagnosticProvider: true,
        },
        serverInfo: { name: 'coCN LSP', version: '0.0.1' },
      });
      break;

    case 'initialized':
      // 客户端已初始化，无需响应
      break;

    case 'shutdown':
      sendResponse(id, null);
      break;

    case 'exit':
      process.exit(0);
      break;

    case 'textDocument/didOpen':
      didOpen(params);
      break;

    case 'textDocument/didChange':
      didChange(params);
      break;

    case 'textDocument/definition':
      handleDefinition(id, params);
      break;

    case 'textDocument/hover':
      handleHover(id, params);
      break;

    case 'textDocument/didSave':
      // 保存时触发诊断
      runDiagnostics(params.textDocument.uri);
      break;

    default:
      // 未知方法，通知客户端
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

// ---------- 文档管理 ----------
function didOpen(params) {
  const uri = params.textDocument.uri;
  documents.set(uri, {
    text: params.textDocument.text,
    version: params.textDocument.version || 1,
  });
  // 打开时自动跑一次诊断
  runDiagnostics(uri);
}

function didChange(params) {
  const uri = params.textDocument.uri;
  const doc = documents.get(uri);
  if (!doc) return;
  // LSP 设置为 Full sync，contentChanges[0].text 是完整文本
  if (params.contentChanges && params.contentChanges.length > 0) {
    doc.text = params.contentChanges[0].text;
    doc.version = params.textDocument.version || doc.version + 1;
  }
  // 防抖诊断：延迟 500ms
  scheduleDiagnostics(uri);
}

// 简单防抖
const pendingTimers = new Map();
function scheduleDiagnostics(uri) {
  if (pendingTimers.has(uri)) clearTimeout(pendingTimers.get(uri));
  pendingTimers.set(uri, setTimeout(() => {
    pendingTimers.delete(uri);
    runDiagnostics(uri);
  }, 500));
}

// ---------- 跳转定义 ----------
/**
 * 解析光标位置的标识符，查找其定义。
 * 匹配模式：
 *   1. 函数 函数名( ... )   —— 函数定义
 *   2. 变量 名 = ...         —— 变量声明
 *   3. 常量 名 = ...         —— 常量声明
 *   4. 名 = 函数( ... )      —— 匿名函数赋值
 */
function handleDefinition(id, params) {
  const uri = params.textDocument.uri;
  const doc = documents.get(uri);
  if (!doc) {
    sendResponse(id, null);
    return;
  }

  const lines = doc.text.split('\n');
  const line = params.position.line;
  const char = params.position.character;

  // 从当前行提取光标下的标识符
  const currentLine = lines[line] || '';
  const word = extractWordAt(currentLine, char);
  if (!word) {
    sendResponse(id, null);
    return;
  }

  // 在全文中搜索定义
  const def = findDefinition(doc.text, word);
  if (def) {
    sendResponse(id, {
      uri: uri,
      range: {
        start: { line: def.line, character: def.col },
        end: { line: def.line, character: def.col + def.length },
      },
    });
  } else {
    sendResponse(id, null);
  }
}

function extractWordAt(line, char) {
  // 标识符字符：字母、数字、下划线、中文
  const isWordChar = (c) => /[A-Za-z0-9_\u4e00-\u9fff]/.test(c);
  if (char > 0 && !isWordChar(line[char])) char--;
  let start = char;
  let end = char;
  while (start > 0 && isWordChar(line[start - 1])) start--;
  while (end < line.length && isWordChar(line[end])) end++;
  if (start === end) return null;
  return line.substring(start, end);
}

function findDefinition(text, word) {
  const lines = text.split('\n');
  // 模式 1: 函数 函数名(
  const fnRe = new RegExp(`^\\s*函数\\s+${escapeRegex(word)}\\s*\\(`);
  // 模式 2: 变量 名 =
  const varRe = new RegExp(`^\\s*变量\\s+${escapeRegex(word)}\\s*=`);
  // 模式 3: 常量 名 =
  const constRe = new RegExp(`^\\s*常量\\s+${escapeRegex(word)}\\s*=`);
  // 模式 4: 名 = 函数(
  const assignRe = new RegExp(`^\\s*${escapeRegex(word)}\\s*=\\s*函数\\s*\\(`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(fnRe))) {
      const idx = line.indexOf(word, line.search(/函数/));
      return { line: i, col: idx, length: word.length };
    }
    if ((m = line.match(varRe))) {
      const idx = line.indexOf(word, line.search(/变量/));
      return { line: i, col: idx, length: word.length };
    }
    if ((m = line.match(constRe))) {
      const idx = line.indexOf(word, line.search(/常量/));
      return { line: i, col: idx, length: word.length };
    }
    if ((m = line.match(assignRe))) {
      const idx = line.indexOf(word);
      return { line: i, col: idx, length: word.length };
    }
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- 悬停 ----------
function handleHover(id, params) {
  const uri = params.textDocument.uri;
  const doc = documents.get(uri);
  if (!doc) {
    sendResponse(id, { contents: [] });
    return;
  }

  const lines = doc.text.split('\n');
  const line = params.position.line;
  const char = params.position.character;
  const word = extractWordAt(lines[line] || '', char);

  if (!word) {
    sendResponse(id, { contents: [] });
    return;
  }

  // 查找定义，附带类型标注
  const def = findDefinition(doc.text, word);
  if (def) {
    const defLine = lines[def.line] || '';
    // 尝试提取返回类型标注（-> 后面的部分）
    let typeInfo = '';
    const arrowMatch = defLine.match(/->\s*(\S+)/);
    if (arrowMatch) typeInfo = `\n\n返回类型: \`${arrowMatch[1]}\``;

    // 尝试提取参数类型
    const paramMatch = defLine.match(/\(([^)]*)\)/);
    let paramInfo = '';
    if (paramMatch && paramMatch[1].trim()) {
      paramInfo = `\n参数: \`${paramMatch[1].trim()}\``;
    }

    sendResponse(id, {
      contents: {
        kind: 'markdown',
        value: `**${word}** (coCN 定义)${paramInfo}${typeInfo}\n\n第 ${def.line + 1} 行`,
      },
    });
  } else {
    // 检查是否是关键字
    const keywords = ['让','变量','常量','函数','返回','如果','否则','若','当','循环','对于','从','到','步长','结束','跳出','继续','真','假','且','或','非','导入','匹配','是','默认','于','在','那么','尝试','捕获','最终','抛出','并发','等待','则','整数','浮点','布尔','字符串','列表','字典','输出','断言','断言相等'];
    if (keywords.includes(word)) {
      sendResponse(id, {
        contents: {
          kind: 'markdown',
          value: `**关键字**: \`${word}\``,
        },
      });
    } else {
      sendResponse(id, { contents: [] });
    }
  }
}

// ---------- 诊断（调用 coCN 解释器）----------
function runDiagnostics(uri) {
  const doc = documents.get(uri);
  if (!doc) return;

  // 如果解释器不存在，跳过
  if (!fs.existsSync(COCN_JS)) {
    // 静默跳过，不报错
    return;
  }

  // 写入临时文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocn-lsp-'));
  const tmpFile = path.join(tmpDir, 'diagnose.co');
  fs.writeFileSync(tmpFile, doc.text, 'utf-8');

  // 运行 coCN 解释器
  const child = spawn('node', [COCN_JS, tmpFile], {
    cwd: PROJECT_ROOT,
    env: process.env,
  });

  let stderr = '';
  let stdout = '';

  child.stderr.on('data', (d) => (stderr += d.toString()));
  child.stdout.on('data', (d) => (stdout += d.toString()));

  child.on('exit', (code) => {
    // 清理临时文件
    try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch (e) {}

    const diagnostics = [];

    if (code !== 0 && stderr) {
      // 解析 stderr 中的错误信息
      const lines = stderr.split('\n');
      for (const line of lines) {
        // 尝试匹配行号信息，例如 "第 3 行" 或 "line 3"
        const lineMatch = line.match(/第\s*(\d+)\s*行/);
        if (lineMatch) {
          const errLine = parseInt(lineMatch[1], 10) - 1; // 0-based
          diagnostics.push({
            severity: 1, // Error
            range: {
              start: { line: errLine, character: 0 },
              end: { line: errLine, character: 100 },
            },
            message: line.trim(),
            source: 'coCN',
          });
        } else if (line.trim() && !line.includes('[coCN]')) {
          // 没有行号的错误，放在第 0 行
          diagnostics.push({
            severity: 1,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 100 },
            },
            message: line.trim(),
            source: 'coCN',
          });
        }
      }
    }

    // 发布诊断
    sendNotification('textDocument/publishDiagnostics', {
      uri: uri,
      diagnostics: diagnostics,
    });
  });

  child.on('error', (err) => {
    try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch (e) {}
    sendNotification('textDocument/publishDiagnostics', {
      uri: uri,
      diagnostics: [
        {
          severity: 1,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
          message: `无法运行 coCN 解释器: ${err.message}`,
          source: 'coCN LSP',
        },
      ],
    });
  });
}

// ---------- 启动 ----------
console.error('[coCN LSP] 服务器已启动，监听 stdio');
