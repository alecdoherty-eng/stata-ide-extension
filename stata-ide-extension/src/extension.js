const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let stataProcess = null;
let activeDatasetPanel = null;
let graphWebviewPanel = null;
let activeDatasetWebview = null;
let pendingRequests = new Map();
let requestIdCounter = 0;
let heartbeatInterval = null;
let activeVariablesSubset = [];
let variablesTreeView = null;
let isForceStopping = false;

let lastClick = { id: null, time: 0 };
function isDoubleClick(id) {
    const now = Date.now();
    if (lastClick.id === id && (now - lastClick.time) < 400) {
        lastClick.id = null;
        return true;
    }
    lastClick = { id, time: now };
    return false;
}

// ============================================================================
// STATA RESULTS WEBVIEW PROVIDER 
// ============================================================================
class StataResultsViewProvider {
    constructor() {
        this._view = null;
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'execute') {
                const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                historyProvider.addCommand({ name: msg.code, code: msg.code, time: timeStr, isError: false });

                this.appendCommand(`\n. ${msg.code}\n`);
                sendToBackend({ cmd: 'execute', code: msg.code });
            }
        });
    }

    appendCommand(text) {
        if (this._view) this._view.webview.postMessage({ type: 'command', text: text });
    }

    appendOutput(text) {
        if (this._view) this._view.webview.postMessage({ type: 'output', text: text });
    }

    appendError(text) {
        if (this._view) this._view.webview.postMessage({ type: 'error_text', text: text });
    }

    clear() {
        if (this._view) this._view.webview.postMessage({ type: 'clear' });
    }

    getHtml() {
        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <style>
                body { display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 0; font-family: monospace; background-color: #1e1e1e; font-size: 13px; line-height: 1.4; }
                #output { flex: 1; overflow-y: auto; padding: 8px; white-space: pre-wrap; }
                #cli { display: flex; padding: 8px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); }
                #cli-prompt { color: #569cd6; margin-right: 8px; font-weight: bold; }
                #cli-input { flex: 1; background: transparent; border: none; color: #d4d4d4; font-family: monospace; font-size: 13px; outline: none; }
            </style>
        </head>
        <body>
            <div id="output"></div>
            <div id="cli">
                <span id="cli-prompt">.</span>
                <input type="text" id="cli-input" placeholder="Type a Stata command and press Enter..." />
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const out = document.getElementById('output');
                const input = document.getElementById('cli-input');
                let isCommandBlock = false;
                
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        const val = input.value.trim();
                        if (val) {
                            vscode.postMessage({ type: 'execute', code: val });
                            input.value = '';
                        }
                    }
                });

                window.addEventListener('message', event => {
                    if (event.data.type === 'insert_cli') {
                        const needsSpace = input.value.length > 0 && !input.value.endsWith(' ');
                        input.value += (needsSpace ? ' ' : '') + event.data.text;
                        input.focus();
                        return;
                    }

                    if (event.data.type === 'clear') {
                        out.innerHTML = '';
                        isCommandBlock = false;
                        return;
                    }
                    
                    if (event.data.type === 'error_text') {
                        const span = document.createElement('span');
                        span.style.color = '#f14c4c'; 
                        span.textContent = event.data.text;
                        out.appendChild(span);
                        out.scrollTop = out.scrollHeight;
                        isCommandBlock = false;
                        return;
                    }

                    const lines = event.data.text.split('\\n');
                    lines.forEach((line, index) => {
                        if (!line && index === lines.length - 1) return;
                        
                        if (event.data.type === 'command' || line.startsWith('. ') || line.startsWith('> ')) {
                            isCommandBlock = true;
                        } else if (line.trim().length > 0) {
                            isCommandBlock = false;
                        }
                        
                        const span = document.createElement('span');
                        span.style.color = isCommandBlock ? '#569cd6' : '#d4d4d4'; 
                        span.textContent = line + (index < lines.length - 1 ? '\\n' : '');
                        out.appendChild(span);
                    });
                    
                    out.scrollTop = out.scrollHeight;
                });
            </script>
        </body>
        </html>`;
    }
}

// ============================================================================
// DATA PROVIDERS & TREE VIEWS
// ============================================================================
class VariablesProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.variables = [];
        this.filterText = "";
    }
    refresh(newVariables) {
        if (newVariables) {
            const oldStates = new Map(this.variables.map(v => [v.name, v.checkboxState]));
            this.variables = newVariables.map(v => ({
                ...v,
                checkboxState: oldStates.has(v.name) ? oldStates.get(v.name) : vscode.TreeItemCheckboxState.Checked
            }));
        }
        this._onDidChangeTreeData.fire();
    }
    setFilter(text) {
        this.filterText = text ? text.toLowerCase() : "";
        vscode.commands.executeCommand('setContext', 'stata-ide.variablesFiltered', this.filterText.length > 0);
        this.refresh();
    }
    selectAll() { this.variables.forEach(v => v.checkboxState = vscode.TreeItemCheckboxState.Checked); this.refresh(); }
    unselectAll() { this.variables.forEach(v => v.checkboxState = vscode.TreeItemCheckboxState.Unchecked); this.refresh(); }

    getTreeItem(element) {
        const item = new vscode.TreeItem(element.name);
        const labelText = element.label ? element.label : '';
        item.description = `[${element.type}]${labelText}`;
        item.tooltip = `${element.name} (${element.type})\n${labelText}`;

        let iconName = 'symbol-variable';
        if (element.type.toLowerCase().startsWith('str')) {
            iconName = 'symbol-string';
        } else if (element.format && (element.format.startsWith('%t') || element.format.startsWith('%d'))) {
            iconName = 'calendar';
        } else {
            iconName = 'symbol-number';
        }

        item.iconPath = new vscode.ThemeIcon(iconName);
        item.checkboxState = element.checkboxState !== undefined ? element.checkboxState : vscode.TreeItemCheckboxState.Checked;
        item.command = { command: 'stata-ide.variables.insert', title: 'Insert Variable', arguments: [element] };
        return item;
    }
    getChildren() {
        if (this.filterText) {
            const filtered = this.variables.filter(v => v.name.toLowerCase().includes(this.filterText) || (v.label && v.label.toLowerCase().includes(this.filterText)));
            return Promise.resolve(filtered);
        }
        return Promise.resolve(this.variables);
    }
}

class StoredResultsProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.results = { r: {}, e: {}, s: {}, g: {} };
    }
    refresh(data) {
        if (data) this.results = data;
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        if (['r() Macros & Scalars', 'e() Estimation', 's() System', '$ Globals'].includes(element.label)) {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon('symbol-class');
            return item;
        }
        const item = new vscode.TreeItem(element.key, vscode.TreeItemCollapsibleState.None);
        item.description = String(element.value);
        item.iconPath = new vscode.ThemeIcon(isNaN(element.value) ? 'symbol-text' : 'symbol-constant');
        item.tooltip = `${element.key} =${element.value}`;

        item.command = { command: 'stata-ide.results.insert', title: 'Insert', arguments: [element] };
        return item;
    }
    getChildren(element) {
        if (!element) {
            return Promise.resolve([
                { label: '$ Globals', type: 'g' },
                { label: 'r() Macros & Scalars', type: 'r' },
                { label: 'e() Estimation', type: 'e' },
                { label: 's() System', type: 's' }
            ]);
        }
        const dataMap = this.results[element.type] || {};
        const children = Object.entries(dataMap).map(([k, v]) => ({ key: k, value: v, prefix: element.type }));
        return Promise.resolve(children);
    }
}

class HistoryProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.history = [];
    }

    addCommand(entry) {
        if (entry && entry.code && entry.code.trim()) {
            this.history.push(entry);
            this._onDidChangeTreeData.fire();
        }
    }

    markLastError() {
        if (this.history.length > 0) {
            this.history[this.history.length - 1].isError = true;
            this._onDidChangeTreeData.fire();
        }
    }

    getTreeItem(element) {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.description = element.time;
        item.tooltip = element.code;

        item.iconPath = element.isError
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
            : new vscode.ThemeIcon('history');

        item.command = { command: 'stata-ide.history.populate', title: 'Populate', arguments: [element] };
        return item;
    }

    getChildren() {
        return Promise.resolve(this.history);
    }
}

const resultsProvider = new StataResultsViewProvider();
const variablesProvider = new VariablesProvider();
const storedResultsProvider = new StoredResultsProvider();
const historyProvider = new HistoryProvider();

// ============================================================================
// LANGUAGE INTELLIGENCE 
// ============================================================================
const stataHelpDocs = [
    { cmd: "assert", min: 3, help: "Verify truth of claim.\n\n**Syntax:** `assert exp [if] [in]`" },
    { cmd: "append", min: 3, help: "Append datasets.\n\n**Syntax:** `append using filename [, options]`" },
    { cmd: "collapse", min: 3, help: "Make dataset of summary statistics.\n\n**Syntax:** `collapse (stat) newvar=var ... [, options]`" },
    { cmd: "count", min: 3, help: "Count observations satisfying specified conditions.\n\n**Syntax:** `count [if] [in]`" },
    { cmd: "decode", min: 3, help: "Decode labeled numeric variables into string.\n\n**Syntax:** `decode varname, generate(newvar)`" },
    { cmd: "describe", min: 1, help: "Describe data in memory or in file.\n\n**Syntax:** `describe [varlist] [, options]`" },
    { cmd: "destring", min: 3, help: "Convert string variables to numeric.\n\n**Syntax:** `destring [varlist], generate(newvarlist) | replace [options]`" },
    { cmd: "display", min: 2, help: "Display strings and values of scalar expressions.\n\n**Syntax:** `display [subexpr] [...]`" },
    { cmd: "drop", min: 2, help: "Eliminate variables or observations.\n\n**Syntax:** `drop varlist` or `drop if exp`" },
    { cmd: "encode", min: 3, help: "Encode string into numeric and label.\n\n**Syntax:** `encode varname, generate(newvar)`" },
    { cmd: "generate", min: 3, help: "Create or change contents of variable.\n\n**Syntax:** `generate newvar = exp [if] [in]`" },
    { cmd: "global", min: 4, help: "Define global macro.\n\n**Syntax:** `global mname [=] exp`" },
    { cmd: "gsort", min: 3, help: "Ascending and descending sort.\n\n**Syntax:** `gsort [+|-] varname ...`" },
    { cmd: "keep", min: 2, help: "Keep variables or observations.\n\n**Syntax:** `keep varlist` or `keep if exp`" },
    { cmd: "list", min: 1, help: "List values of variables.\n\n**Syntax:** `list [varlist] [if] [in] [, options]`" },
    { cmd: "local", min: 3, help: "Define local macro.\n\n**Syntax:** `local lname [=] exp`" },
    { cmd: "merge", min: 3, help: "Merge datasets.\n\n**Syntax:** `merge 1:1 varlist using filename [, options]`" },
    { cmd: "regress", min: 3, help: "Linear regression.\n\n**Syntax:** `regress depvar [indepvars] [if] [in] [weight] [, options]`" },
    { cmd: "rename", min: 3, help: "Rename variable.\n\n**Syntax:** `rename oldvar newvar`" },
    { cmd: "replace", min: 3, help: "Replace contents of existing variable.\n\n**Syntax:** `replace oldvar = exp [if] [in]`" },
    { cmd: "reshape", min: 4, help: "Convert data from wide to long form and vice versa.\n\n**Syntax:** `reshape long/wide stub, i(varlist) j(varname)`" },
    { cmd: "sort", min: 2, help: "Sort data.\n\n**Syntax:** `sort varlist [in] [, stable]`" },
    { cmd: "summarize", min: 2, help: "Summary statistics.\n\n**Syntax:** `summarize [varlist] [if] [in] [weight] [, options]`" },
    { cmd: "sysuse", min: 3, help: "Use shipped dataset.\n\n**Syntax:** `sysuse filename [, clear]`" },
    { cmd: "tabulate", min: 3, help: "One- and two-way tables of frequencies.\n\n**Syntax:** `tabulate varname1 [varname2] [if] [in] [weight] [, options]`" },
    { cmd: "tostring", min: 3, help: "Convert numeric variables to string.\n\n**Syntax:** `tostring varlist, generate(newvarlist) | replace [options]`" },
    { cmd: "twoway", min: 2, help: "Two-way scatterplots, line plots, etc.\n\n**Syntax:** `twoway plot [if] [in] [, twoway_options]`" }
];

class StataCompletionProvider {
    constructor(vProvider) { this.variablesProvider = vProvider; }
    provideCompletionItems(document, position) {
        const varItems = this.variablesProvider.variables.map(v => {
            const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Variable);
            item.detail = `[${v.type}]${v.label}`;
            item.documentation = `Format: ${v.format}`;
            return item;
        });

        const cmdItems = stataHelpDocs.map(d => {
            const item = new vscode.CompletionItem(d.cmd, vscode.CompletionItemKind.Function);
            item.detail = "Stata Command";
            item.documentation = new vscode.MarkdownString(d.help);
            return item;
        });

        return varItems.concat(cmdItems);
    }
}

class StataHoverProvider {
    constructor(vProvider) { this.variablesProvider = vProvider; }
    provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position);
        if (!range) return null;
        const word = document.getText(range);
        const wordLower = word.toLowerCase();

        const variable = this.variablesProvider.variables.find(v => v.name === word);
        if (variable) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**Variable:** \`${variable.name}\`\n\n**Label:** ${variable.label || '*none*'}\n\n**Type:** ${variable.type}\n\n**Format:** ${variable.format}`);
            return new vscode.Hover(md, range);
        }

        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        const docMatch = stataHelpDocs.find(d => wordLower.length >= d.min && d.cmd.startsWith(wordLower));
        if (docMatch) {
            md.appendMarkdown(`**${docMatch.cmd.toUpperCase()}**\n\n${docMatch.help}\n\n`);
        } else {
            md.appendMarkdown(`**${wordLower}**\n\n`);
        }

        md.appendMarkdown(`--- \n\n[▶ View native Stata help for '${wordLower}'](command:stata-ide.help?${encodeURIComponent(JSON.stringify(wordLower))})`);
        return new vscode.Hover(md, range);
    }
}

class StataDocumentSymbolProvider {
    provideDocumentSymbols(document, token) {
        const symbols = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const match = line.text.match(/^\s*\*\*\#\s*(.*)$/);
            if (match) {
                const name = match[1].trim() || "Bookmark";
                const symbol = new vscode.DocumentSymbol(
                    name, '', vscode.SymbolKind.String, line.range, line.range
                );
                symbols.push(symbol);
            }
        }
        return symbols;
    }
}

// ============================================================================
// IPC ENGINE & BACKEND
// ============================================================================
function sendToBackend(payload) {
    return new Promise((resolve, reject) => {
        requestIdCounter++;
        payload.req_id = requestIdCounter;
        pendingRequests.set(requestIdCounter, { resolve, reject });
        if (stataProcess && stataProcess.stdin) {
            stataProcess.stdin.write(JSON.stringify(payload) + '\n');
        } else {
            reject(new Error("Stata process not running"));
        }
    });
}

function initializeBackend(context) {
    const config = vscode.workspace.getConfiguration('stata-ide');
    const pythonPath = config.get('pythonPath') || 'python';
    const stataPath = config.get('stataPath') || '';

    const scriptPath = path.join(context.extensionPath, 'backend', 'stata_server.py');
    const args = [scriptPath];
    if (stataPath) args.push('--stata-path', stataPath);

    const env = Object.assign({}, process.env, { PYTHONUNBUFFERED: "1" });
    stataProcess = spawn(pythonPath, args, { env });

    let stdoutBuffer = "";

    stataProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        let newlineIdx;

        while ((newlineIdx = stdoutBuffer.indexOf('\n')) > -1) {
            const line = stdoutBuffer.substring(0, newlineIdx);
            stdoutBuffer = stdoutBuffer.substring(newlineIdx + 1);

            if (!line.trim()) continue;

            try {
                const parsed = JSON.parse(line);

                if (parsed.req_id && pendingRequests.has(parsed.req_id)) {
                    const { resolve } = pendingRequests.get(parsed.req_id);
                    resolve(parsed);
                    pendingRequests.delete(parsed.req_id);
                }

                if (parsed.type === 'output') {
                    if (parsed.data.includes('[Stata Error]:')) {
                        resultsProvider.appendError(parsed.data);
                    } else {
                        resultsProvider.appendOutput(parsed.data);
                    }
                } else if (parsed.type === 'variables') {
                    variablesProvider.refresh(parsed.data);
                } else if (parsed.type === 'execution_finished') {
                    if (!activeDatasetPanel) {
                        vscode.commands.executeCommand('stata-ide.viewActiveDataset');
                    } else {
                        activeDatasetWebview.postMessage({ type: 'resetData' });
                        sendToBackend({ cmd: 'fetch_active', start: 0, end: 150, variables: activeVariablesSubset }).catch(() => { });
                    }
                } else if (parsed.type === 'stored_results') {
                    storedResultsProvider.refresh(parsed.data);
                } else if (parsed.type === 'graph') {
                    showGraphWebview(parsed.data, context);
                } else if (parsed.type === 'dataChunk' && activeDatasetWebview) {
                    activeDatasetWebview.postMessage({ type: 'chunkData', data: parsed.data || [], total: parsed.total || 0, columns: parsed.columns || [] });
                } else if (parsed.type === 'error') {
                    historyProvider.markLastError();
                }
            } catch (e) {
                console.error("Failed to parse IPC message chunk:", e);
            }
        }
    });

    stataProcess.on('exit', () => {
        if (isForceStopping) {
            isForceStopping = false;
            initializeBackend(context);
        } else {
            vscode.window.showErrorMessage("Stata Backend process exited.", "Restart Engine").then(choice => {
                if (choice === "Restart Engine") initializeBackend(context);
            });
        }
    });

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        sendToBackend({ cmd: "ping" }).catch(() => { });
    }, 10000);
}

// ============================================================================
// WEBVIEW HTML GENERATORS 
// ============================================================================
async function showGraphWebview(imagePath, context) {
    if (!graphWebviewPanel) {
        let targetColumn = vscode.ViewColumn.Beside;
        if (activeDatasetPanel) {
            try {
                const col = activeDatasetPanel.viewColumn || vscode.ViewColumn.Beside;
                activeDatasetPanel.reveal(col, false);
                await new Promise(resolve => setTimeout(resolve, 150));
                await vscode.commands.executeCommand('workbench.action.splitEditorDown');
                targetColumn = vscode.ViewColumn.Active;
            } catch (e) { targetColumn = vscode.ViewColumn.Beside; }
        }

        const resourcesFolder = path.join(context.extensionPath, 'resources');
        graphWebviewPanel = vscode.window.createWebviewPanel('stataGraph', 'Stata Graph Output', targetColumn, { enableScripts: true, localResourceRoots: [vscode.Uri.file(resourcesFolder)] });
        const chartIconUri = vscode.Uri.file(path.join(resourcesFolder, 'chart-file.svg'));
        graphWebviewPanel.iconPath = { light: chartIconUri, dark: chartIconUri };
        graphWebviewPanel.onDidDispose(() => { graphWebviewPanel = null; });
    }

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const imgSrc = `data:image/png;base64,${base64Image}`;
        graphWebviewPanel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;">
                <style>body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: var(--vscode-editor-background); } img { max-width: 100%; max-height: 100%; object-fit: contain; }</style>
            </head>
            <body><img src="${imgSrc}" alt="Stata Graph" /></body>
            </html>
        `;
        graphWebviewPanel.reveal(graphWebviewPanel.viewColumn || vscode.ViewColumn.Active, true);
    } catch (err) { }
}

function getGridHtml(fetchCommandName) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            html, body { margin: 0; padding: 0; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: monospace; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
            #stats-bar { flex: 0 0 auto; padding: 6px 12px; font-weight: bold; background-color: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); z-index: 10; font-size: 14px; }
            
            #grid-wrapper { flex: 1 1 auto; position: relative; overflow: auto; background-color: var(--vscode-editor-background); }
            #scroll-sizer { position: absolute; top: 0; left: 0; width: 1px; z-index: -1; }
            
            table { border-collapse: collapse; width: 100%; table-layout: fixed; position: absolute; top: 0; left: 0; background-color: var(--vscode-editor-background); }
            th, td { 
                padding: 4px 8px; text-align: left; white-space: nowrap; 
                border-bottom: 1px solid var(--vscode-panel-border); 
                border-right: 1px solid var(--vscode-panel-border); 
                min-width: 60px; max-width: 400px; width: 120px;
                overflow: hidden; text-overflow: ellipsis;
            }
            
            th { 
                position: sticky; 
                top: 0; 
                background-color: var(--vscode-editor-background); 
                z-index: 2; 
                box-shadow: inset 0 1px 0 var(--vscode-editor-background), inset 0 -1px 0 var(--vscode-panel-border);
                background-clip: padding-box;
                border-bottom: none;
                user-select: none;
            }

            .resizer {
                position: absolute; right: 0; top: 0; bottom: 0; width: 5px;
                cursor: col-resize; z-index: 3;
            }
            .resizer:hover { background-color: var(--vscode-focusBorder); }
            
            tr:nth-child(even) td { background-color: var(--vscode-list-hoverBackground); }
        </style>
    </head>
    <body>
        <div id="stats-bar">Loading dataset...</div>
        <div id="grid-wrapper">
            <div id="scroll-sizer"></div>
            <table id="data-table">
                <thead><tr id="header-row"></tr></thead>
                <tbody id="data-body"></tbody>
            </table>
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            
            const ROW_HEIGHT = 27; 
            let totalObs = 0;
            let currentCols = [];
            
            let renderedStart = 0;
            let requestedStart = 0;
            let scrollDebounce = null;
            
            const wrapper = document.getElementById('grid-wrapper');
            const sizer = document.getElementById('scroll-sizer');
            const header = document.getElementById('header-row');
            const body = document.getElementById('data-body');
            const stats = document.getElementById('stats-bar');
            
            function makeResizable(table) {
                const cols = table.querySelectorAll('th');
                [].forEach.call(cols, function (col) {
                    if(col.querySelector('.resizer')) return; 
                    const resizer = document.createElement('div');
                    resizer.classList.add('resizer');
                    col.appendChild(resizer);
                    
                    let x = 0;
                    let w = 0;
                    
                    const mouseDownHandler = function (e) {
                        x = e.clientX;
                        const styles = window.getComputedStyle(col);
                        w = parseInt(styles.width, 10);
                        document.addEventListener('mousemove', mouseMoveHandler);
                        document.addEventListener('mouseup', mouseUpHandler);
                    };
                    const mouseMoveHandler = function (e) {
                        const dx = e.clientX - x;
                        col.style.width = (w + dx) + 'px';
                    };
                    const mouseUpHandler = function () {
                        document.removeEventListener('mousemove', mouseMoveHandler);
                        document.removeEventListener('mouseup', mouseUpHandler);
                    };
                    resizer.addEventListener('mousedown', mouseDownHandler);
                });
            }

            window.addEventListener('message', event => {
                if (event.data.type === 'chunkData') {
                    currentCols = event.data.columns || [];
                    totalObs = event.data.total || 0;
                    
                    stats.textContent = totalObs.toLocaleString() + ' observations, ' + currentCols.length + ' variables';
                    sizer.style.height = (totalObs * ROW_HEIGHT + 35) + 'px';
                    
                    renderedStart = requestedStart;
                    renderChunk(event.data.data || []);
                    
                } else if (event.data.type === 'resetData') {
                    renderedStart = 0;
                    requestedStart = 0;
                    body.innerHTML = '';
                    header.innerHTML = '';
                    stats.textContent = 'Loading dataset...';
                }
            });
            
            function renderChunk(rows) {
                if (!currentCols || currentCols.length === 0) {
                    header.innerHTML = '<th>No dataset loaded in memory</th>';
                    body.innerHTML = '';
                    return;
                }

                const expectedHeader = '<th style="width: 50px;">#</th>' + currentCols.map(c => \`<th title="\${c.name}">\${c.name}</th>\`).join('');
                if (header.innerHTML !== expectedHeader) {
                    header.innerHTML = expectedHeader;
                    makeResizable(document.getElementById('data-table'));
                }
                
                let html = '';
                const topPadding = renderedStart * ROW_HEIGHT;
                
                if (topPadding > 0) {
                    html += \`<tr style="height: \${topPadding}px; background: transparent;"><td colspan="\${currentCols.length + 1}" style="border: none; padding: 0;"></td></tr>\`;
                }

                rows.forEach((r, idx) => {
                    html += \`<tr style="height: \${ROW_HEIGHT}px"><td>\${renderedStart + idx + 1}</td>\` + 
                            currentCols.map(c => \`<td title="\${r[c.name] !== undefined && r[c.name] !== null ? r[c.name] : ''}">\${r[c.name] !== undefined && r[c.name] !== null ? r[c.name] : ''}</td>\`).join('') + 
                            '</tr>';
                });
                
                body.innerHTML = html;
            }
            
            wrapper.addEventListener('scroll', () => {
                const scrollTop = wrapper.scrollTop;
                const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 30);
                
                clearTimeout(scrollDebounce);
                scrollDebounce = setTimeout(() => {
                    if (Math.abs(startRow - requestedStart) > 40 && startRow < totalObs) {
                        requestedStart = startRow;
                        vscode.postMessage({ command: '${fetchCommandName}', start: startRow, end: startRow + 200 });
                    }
                }, 100);
            });
            
            requestedStart = 0;
            vscode.postMessage({ command: '${fetchCommandName}', start: 0, end: 200 });
        </script>
    </body>
    </html>`;
}

// ============================================================================
// EXTENSION ACTIVATION
// ============================================================================
function activate(context) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('stataResultsView', resultsProvider));

    variablesTreeView = vscode.window.createTreeView('stata-ide-variables-view', { treeDataProvider: variablesProvider, canSelectMany: true });
    context.subscriptions.push(variablesTreeView);

    vscode.window.registerTreeDataProvider('stata-ide-stored-results-view', storedResultsProvider);
    vscode.window.registerTreeDataProvider('stata-ide-history-view', historyProvider);

    const stataSelector = [
        { scheme: 'file', language: 'stata' },
        { pattern: '**/*.do' },
        { pattern: '**/*.ado' }
    ];

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(stataSelector, new StataCompletionProvider(variablesProvider)),
        vscode.languages.registerHoverProvider(stataSelector, new StataHoverProvider(variablesProvider)),
        vscode.languages.registerDocumentSymbolProvider(stataSelector, new StataDocumentSymbolProvider())
    );

    initializeBackend(context);

    const executeCodeCmd = vscode.commands.registerCommand('stata-ide.executeCode', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        let code = '';
        let historyName = '';

        if (selection.isEmpty) {
            code = editor.document.getText();
            historyName = path.basename(editor.document.fileName) || 'Entire File';
        } else {
            code = editor.document.getText(selection);
            historyName = `Code chunk (Line ${selection.start.line + 1} to${selection.end.line + 1})`;
        }

        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        resultsProvider.appendCommand(`\n. ${code.split('\n')[0]}\n`);

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: historyName, code: code, time: timeStr, isError: false });

        sendToBackend({ cmd: "execute", code: code });
    });

    const executeFileCmd = vscode.commands.registerCommand('stata-ide.executeFile', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const code = editor.document.getText();
        const fileName = path.basename(editor.document.fileName) || 'Untitled.do';

        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        resultsProvider.appendCommand(`\n. do "${editor.document.fileName}"\n`);

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: fileName, code: code, time: timeStr, isError: false });

        sendToBackend({ cmd: "execute", code: code });
    });

    const stopExecutionCmd = vscode.commands.registerCommand('stata-ide.stopExecution', () => {
        if (stataProcess) {
            isForceStopping = true;
            resultsProvider.appendError('\n[Execution Aborted by User - Restarting Stata Engine...]\n');
            stataProcess.kill('SIGKILL');
        }
    });

    const viewDatasetCmd = vscode.commands.registerCommand('stata-ide.viewActiveDataset', () => {
        if (activeDatasetPanel) {
            activeDatasetPanel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }

        activeDatasetPanel = vscode.window.createWebviewPanel(
            'activeDatasetViewer', 'Stata: Active Dataset',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        const gridIconUri = vscode.Uri.file(path.join(context.extensionPath, 'resources', 'dta-file.png'));
        activeDatasetPanel.iconPath = { light: gridIconUri, dark: gridIconUri };

        activeDatasetWebview = activeDatasetPanel.webview;
        activeDatasetPanel.webview.html = getGridHtml('fetchActiveChunk');

        activeDatasetPanel.onDidDispose(() => { activeDatasetWebview = null; activeDatasetPanel = null; });
        activeDatasetPanel.webview.onDidReceiveMessage(e => {
            if (e.command === 'fetchActiveChunk') { sendToBackend({ cmd: 'fetch_active', start: e.start, end: e.end, variables: activeVariablesSubset }); }
        });
    });

    const filterLogic = async () => {
        const userInput = await vscode.window.showInputBox({ prompt: "Filter variables", value: variablesProvider.filterText });
        if (userInput !== undefined) variablesProvider.setFilter(userInput);
    };

    const filterVariablesCmd = vscode.commands.registerCommand('stata-ide.variables.filter', filterLogic);
    const filterActiveCmd = vscode.commands.registerCommand('stata-ide.variables.filterActive', filterLogic);
    const clearFilterCmd = vscode.commands.registerCommand('stata-ide.variables.clearFilter', () => { variablesProvider.setFilter(''); });
    const selectAllCmd = vscode.commands.registerCommand('stata-ide.variables.selectAll', () => { variablesProvider.selectAll(); });
    const unselectAllCmd = vscode.commands.registerCommand('stata-ide.variables.unselectAll', () => { variablesProvider.unselectAll(); });

    const browseSelectedCmd = vscode.commands.registerCommand('stata-ide.browseSelected', () => {
        let selected = variablesProvider.variables.filter(v => v.checkboxState === vscode.TreeItemCheckboxState.Checked).map(v => v.name);

        if (selected.length === 0 && variablesTreeView.selection.length > 0) {
            selected = variablesTreeView.selection.map(v => v.name);
        }

        if (selected.length === 0) {
            vscode.window.showInformationMessage("No variables selected or checked. Showing all.");
            activeVariablesSubset = [];
        } else {
            activeVariablesSubset = selected;
        }

        if (activeDatasetPanel) {
            activeDatasetWebview.postMessage({ type: 'resetData' });
            sendToBackend({ cmd: 'fetch_active', start: 0, end: 150, variables: activeVariablesSubset });
        } else {
            vscode.commands.executeCommand('stata-ide.viewActiveDataset');
        }
    });

    const insertVariableCmd = vscode.commands.registerCommand('stata-ide.variables.insert', (arg) => {
        const varName = (typeof arg === 'string') ? arg : (arg.name || '');
        if (isDoubleClick(`var_${varName}`)) {
            vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
            if (resultsProvider._view && varName) {
                resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: varName });
            }
        }
    });

    const insertResultCmd = vscode.commands.registerCommand('stata-ide.results.insert', (arg) => {
        let text = "";
        if (typeof arg === 'string') text = arg;
        else if (arg && arg.key) text = arg.prefix === 'g' ? `$${arg.key}` : `\`${arg.prefix}(${arg.key})'`;

        if (isDoubleClick(`res_${text}`)) {
            vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
            if (resultsProvider._view && text) {
                resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: text });
            }
        }
    });

    const populateHistoryCmd = vscode.commands.registerCommand('stata-ide.history.populate', (arg) => {
        const cmdText = (typeof arg === 'string') ? arg : (arg.code || '');
        if (isDoubleClick(`hist_${cmdText}`)) {
            vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
            if (resultsProvider._view && cmdText) {
                resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: cmdText });
            }
        }
    });

    const helpCmd = vscode.commands.registerCommand('stata-ide.help', (cmdName) => {
        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        resultsProvider.appendCommand(`\n. help ${cmdName}\n`);
        sendToBackend({ cmd: "execute", code: `help ${cmdName}` });
    });

    const generateCodebookCmd = vscode.commands.registerCommand('stata-ide.generateCodebook', () => {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: "codebook", code: "codebook", time: timeStr, isError: false });
        sendToBackend({ cmd: "execute", code: "codebook" });
    });

    context.subscriptions.push(
        executeCodeCmd, executeFileCmd, stopExecutionCmd, viewDatasetCmd, filterVariablesCmd, filterActiveCmd,
        clearFilterCmd, selectAllCmd, unselectAllCmd, browseSelectedCmd, insertVariableCmd,
        insertResultCmd, populateHistoryCmd, helpCmd, generateCodebookCmd
    );
}

function deactivate() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (stataProcess) stataProcess.kill();
}

module.exports = { activate, deactivate };