'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let lspProcess = null;
let lspConnection = null;

/**
 * 激活扩展：启动 LSP 服务器并建立 stdio 通信
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('coCN 扩展已激活');

  // 启动 LSP 服务器
  startLspServer(context);

  // 注册命令：重新启动 LSP
  const restartCmd = vscode.commands.registerCommand('cocn.restartServer', () => {
    stopLspServer();
    startLspServer(context);
    vscode.window.showInformationMessage('coCN LSP 服务器已重启');
  });
  context.subscriptions.push(restartCmd);

  // 注册命令：手动诊断
  const checkCmd = vscode.commands.registerCommand('cocn.checkFile', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (doc.languageId !== 'cocn') return;
    // 触发 didChange 来重新诊断
    vscode.commands.executeCommand('cocn.restartServer');
  });
  context.subscriptions.push(checkCmd);
}

function startLspServer(context) {
  const config = vscode.workspace.getConfiguration('cocn');
  let serverPath = config.get('lspPath', '');

  // 自动查找 server.js
  if (!serverPath) {
    const candidates = [
      path.join(context.extensionPath, '..', 'lsp', 'server.js'),
      path.join(context.extensionPath, 'lsp', 'server.js'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        serverPath = c;
        break;
      }
    }
  }

  if (!serverPath || !fs.existsSync(serverPath)) {
    vscode.window.showWarningMessage(
      '未找到 coCN LSP 服务器 (server.js)。请在设置中指定 cocn.lspPath。语法高亮仍可正常使用。'
    );
    return;
  }

  console.log('启动 LSP 服务器:', serverPath);

  lspProcess = spawn('node', [serverPath], {
    cwd: path.dirname(path.dirname(serverPath)), // 项目根目录
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  lspProcess.stderr.on('data', (data) => {
    console.error('[LSP stderr]', data.toString());
  });

  lspProcess.on('exit', (code) => {
    console.log('LSP 服务器退出，代码:', code);
    lspProcess = null;
  });

  // 初始化
  sendLspRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: vscode.workspace.rootPath ? vscode.Uri.file(vscode.workspace.rootPath).toString() : null,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          definition: true,
          hover: true,
          publishDiagnostics: true,
        },
      },
    },
  });

  // 绑定文档事件
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId !== 'cocn') return;
      sendLspNotification('textDocument/didOpen', {
        textDocument: {
          uri: doc.uri.toString(),
          languageId: doc.languageId,
          version: doc.version,
          text: doc.getText(),
        },
      });
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== 'cocn') return;
      sendLspNotification('textDocument/didChange', {
        textDocument: {
          uri: event.document.uri.toString(),
          version: event.document.version,
        },
        contentChanges: [
          {
            range: null,
            text: event.document.getText(),
          },
        ],
      });
    })
  );

  // 监听来自服务器的诊断（用 Buffer 按字节分帧，兼容中文）
  let buffer = Buffer.alloc(0);
  lspProcess.stdout.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    let idx;
    while ((idx = buffer.indexOf('\r\n\r\n')) !== -1) {
      const headerPart = buffer.slice(0, idx).toString('utf8');
      const m = headerPart.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        buffer = buffer.slice(idx + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = idx + 4;
      if (buffer.length < bodyStart + len) break;
      const body = buffer.slice(bodyStart, bodyStart + len).toString('utf8');
      buffer = buffer.slice(bodyStart + len);
      try {
        const msg = JSON.parse(body);
        handleLspMessage(msg);
      } catch (e) {
        console.error('解析 LSP 消息失败:', e);
      }
    }
  });
}

function handleLspMessage(msg) {
  if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
    const { uri, diagnostics } = msg.params;
    // 转换并显示诊断
    const converted = (diagnostics || []).map((d) => ({
      severity: d.severity || 1,
      range: {
        start: { line: d.range.start.line, character: d.range.start.character },
        end: { line: d.range.end.line, character: d.range.end.character },
      },
      message: d.message,
      source: 'coCN',
    }));
    const collection = vscode.languages.createDiagnosticCollection('cocn');
    collection.set(vscode.Uri.parse(uri), converted);
  }
}

function sendLspRequest(req) {
  if (!lspProcess || !lspProcess.stdin.writable) return;
  const body = JSON.stringify(req);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  lspProcess.stdin.write(header + body);
}

function sendLspNotification(method, params) {
  sendLspRequest({ jsonrpc: '2.0', method, params });
}

function stopLspServer() {
  if (lspProcess) {
    try {
      lspProcess.kill();
    } catch (e) {}
    lspProcess = null;
  }
}

function deactivate() {
  stopLspServer();
}

module.exports = { activate, deactivate };
